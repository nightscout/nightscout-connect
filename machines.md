# Theory of Operation

The project uses xstate to implement state machines

While inputs and outputs may have side-effects as binding queries to temporal
ranges, or invalidating credentials, or persisting data in long term storage,
the interfaces and logic should be testable.  A key benefit of xstate is
defining a series of events, and being able to inject the behavior from
configuration.

## Hello world

```
Input -> Transform -> Output
```

The basic premise is to take Input from a custom data source, use a custom
transformation to a Nightscout compatible standard, and then store it in
Nightscout.  Testing and developing a "sidecar" on the command line can be
easier than internal Nightscout development.  The `lib/outputs/` directory
contains promises that can use Nightscout's internal storage API, or Axios API
to update a Nightscout instance via REST API.

See `junk.js`, `demo.js` or `testable_driver.js` for simplified, "hard-coded" versions of
what happens in `lib/machines/`.


## Machines

### Imperative Fetching Frame

The general flow from `Input -> Transform -> Output` has some nuance.
Depending on the type of Input, the protocols for fetching data will be
different.  Many source input resources require authentication schemes that
vary, as well as different data access models.  However, the generic sequence
of steps is always the same.  The fetch frame is intended to perform the
sequence of steps exactly once, terminating in a Done state.

`lib/machines/fetch.js` exposes fetch machine, which models the general flow as
a sequence of steps, or states:

  1. Idle - only present as a technical detail.
  2. Waiting - Recognizing that these components are run on shared
     infrastructure, that this is run in a cycle, and that there are retries
     involved, this Waiting state allows injecting delays if and when needed.
  3. Auth - We tried modeling the authentication protocol steps directly here.
     However, when considering refresh and expiry logic, found it simpler to emit
     a `SESSION_REQUIRED` event to bus or parent machines managing this flow.  The
     `Auth` state will move to the next step when the bus resolves the session by
     sending a `SESSION_RESOLVED` signal back to this fetch frame.  This allows
    another machine, the Session machine, to manage session re-use, refresh,
     and expiry without exposing those details here.  We need an active session
     to continue, but don't care how.
  4. DetermineGaps - Sends an event called `GAP_ANALYSIS` to the bus or parent
     machines managing this flow.  This uses the ability for xstate to inject
     "services" at runtime.  There is an adapter that calls the configured
     source's `gap_for` when it iexists to help fulfill this service as a
     promise and saves the result in `last_known`
  5. Fetching - Use promises injected from the configured source to fetch the
     raw data from the data source.  This will emit `DATA_RECEIVED` to the
     bus/machines managing this frame.
  6. Transforming - There is a built in adapter to convert functions from the
     configured source to an xstate service.  The source should expose a pure
     function for this.
  7. Persisting - Send the data emitted into the configured output driver via a
     promise called `persister`.  Finishing this counts the fetching frame as a
     successful one, and allows the next fetching cycle to be scheduled or aligned
     against this one, in many circumstances.  This is done by emitting calling
     `align_schedule` as an action which is mapped to the source implementation
     if one is available.


Any errors will force transitioning to the `Error` state, which increments the
counters instrumenting success, and failures.  If conditions permit retrying,
it will transition to Retry and Waiting before retrying this scheduled flow.

After Success or the permissible retries, the fetch frame will terminate in the
Done state.


## The Session machine

Most input sources have a way to fetch data, as well as a protocol for
creating, maintaining, and expiring a session.  Session management is often
independent from the data fetching cycle, allowing sessions to be re-used.
After sessions expire, a new session must be created before more data can be
fetched.

Source inputs must provide promises:
* that use credentials and resolves to authenticated information
* uses authenticated information and resolves to a session
Source inputs may also provide:
* (optional) - takes authenticated information and a sesion and refreshes, resolves to new session

The builder is used to map these promises to the adapter in the machine's prelude.

The machine moves through these states in parallel to the consumer, the imperative fetching frame.

* Inactive, for technical reasons only
* Fresh.Authenticating - The builder will pass the prelude adapter the
  authentication function registered for the source.  It mut be a promise that
  resolves to authenticated information which is saved in the context and
  passed to the other services and states.
* Fresh.Authorizing - takes session returned from Authenticated and passed via the machine's context and resolves a session.
* Fresh.Established
* Active
* Refreshing - optionally, if the session supports refresh, this calls a promise exposed from the source that will resolve a new session.
* Expired

A session may be in any state when the cycle for fetching data demands new
data.  When a consumer requires new data, the consumer will generate a
`SESSION_REQUIRED` event on the bus, and then the bus will pass the event to
this child machine.  During an Active session, the pre-existing session is
resolved from the machine's context, otherewise, the machine will attempt to
authenticate, and then authorize in order to produce `SESSION_RESOLVED` events
in response.  Errors are forwarded to the bus/owning machine.

## The Cycle Machine

The premise is to own and manage consumer machines, such as the fetching frame
on a regular, periodic interval.  For CGM devices, this is nominally five
minutes, although some providers are known to update on an hourly or daily cadence.
The configured expected data interval helps establish the basis of this
cadence.  Each vendor may describe one or more cycle machines consuming
sesssions from that vendor.  The cycle machine is owned by the polling machine
and forwards `SESSION_RESOLVED`, `SESSION_REQUIRED`, and `SESSION_ERROR`
between polling/bus machine and the fetch machine.  Consumers on a cycle
machine will loop through
these transitions until the agent stops.


* Init
* Ready - Implement a dynamic delay, defined by exponential delay on
  `frames_missing` and a basis configured by the source and builder.  This is
  configured in `MAIN_CYCLE_DELAY`.  The main frame operation is ready after a
  delay, especially in the case of error.
* Operating - Allocate and run a fetch machine for this configured source.
  If a frame is unable to complete, it increments `frames_missing`, increasing
  the delay for the next scheduled cycle.
* After - Schedule the next cycle based on the results of the previous frame.
  The builder and source configure `EXPECTED_DATA_INTERVAL_DELAY` to use
  `align_schedule` for this delay. A base delay and jitter is typically added
  based on the previous successful fetch.
  Sources that do no implement a way to `align_schedule` and register it with
  the builder will always use the expected data interval registered for this
  loop or cycle.

## The Poller/Bus machine

The poller machine acts as a bus to own the session, any needed cycle machines
that a source has registered, and to pass messages between them.

* Idle
* Running
  * Session
  * ...Cycle[s] - each source can register multiple cycles or loops
    * Fetch - each cycle owns and repeats each fetch in an infinite loop.

The builder constructs and attaches a cycle machine for each `register_loop`.
Each cycle in turn owns a fetch machine.

### Builder

The builder and the adapter preludes at the beginning of the machine sources
are brittle, but successfully decouple tainting vendor code with xstate idioms
and vice versa.  Without some similar interface, vendor code would start to be
littered with callbacks and additional `(context,event)` type of signatures.
However, beyond the builder interface, the adapters are inconsistently named, and
promises are mixed into poorly organized structs with utilities.

Each cloud vendor has a core I/O interface that are promises:
* doAuthenticate - from an instance of a source vendor, resolve to authenticated information
* doAuthorize - given authenticated information passed as parameter, resolve to session information
* doFetchData - given session information passed as parameter, resolve raw data batch

Source vendor code does not interface directly with xstate, but by declaring
the loops and session promises, along with the expected backoff, retry, and
expected data intervals.

#### Example Nightscout source

In this example, `impl` is a bunch of I/O promises exported by the Nightscout
source module.

```
    builder.support_session({
      // the adapter/prelude in lib/machines/session will map this to
      // doAuthenticate as a service during the Authenticating step
      authenticate: impl.authFromCredentials,
      // the adapter/prelude in lib/machines/session will map this to
      // doAuthorize as a service during the Authorizing step
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        // assign a fixed value in MS to these values
        // send REFRESH signal after
        REFRESH_AFTER_SESSSION_DELAY: 28800000,
        // send SESSION_EXPIRED after
        EXPIRE_SESSION_DELAY: 28800000,
      }
    });



    // the prelude/adapter in lib/machines/cycle.js will build a cycle machine
    // owned by the poller, called NightscoutEntries.
    builder.register_loop('NightscoutEntries', {
      tracker: tracker_for,
      // defines options for the fetch machine
      frame: {
        // use the promise dataFromSesssion and map it to the fetch machine's
        // main dataFromSesssion/dataFetchService.
        impl: impl.dataFromSesssion,
        // utility, use After Operation to align the next data fetch cycle.
        // sometimes this yields better results than waiting five minutes from
        // "now."
        align_schedule: impl.align_to_glucose,
        // lib/machines/fetch adapter/prelude will map this promise to the
        // transformService during the Transforming state.
        transform: impl.transformGlucose,
        backoff: {
          // defines WAIT_BEFORE_RETRY_DELAY exponential delay behavior
          // in fetch machine
          // wait ten seconds before retrying to get data
          // then increase on exponential basis
          interval_ms: 10000

        },
        // only try 3 times per frame to get data
        maxRetries: 3
      },
      // expect new data 5 minutes after last success per cycle
      // without align_schedule et al, it will be this amount of time from the
      // end of the cycle.  lib/machines/cycle maps this to EXPECTED_DATA_INTERVAL_DELAY.
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        // defines exponential back off on frames_missing, in MAIN_CYCLE_DELAY
        // during Ready state on a cycle.
        // when frame exhausts its retries and the cycle still fails, how long
        // to wait before the next cycle.
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000
      },
    });
```

The source transform function will take the batch of data returned from the
`DATA_RECEIVED` event and must return a Nightscout compatible batch, consisting
of `{ entries: [ ], treatments: [ ], profile: [ ], devicestatus: [ ] }`.

### Sources

`lib/sources/` contains modules specific to each vendor.

#### Configuring

The cli entry point uses yargs to parse environment variables.  The
mechanism is identical to the way Nightscout parses environment variables
for extended settings, using the prefix `CONNECT_`.  In order for the
entrypoints to configure a source, the module must export a function 
that returns `{ ...impl, generate_driver (builder)  }`.  `generate_driver` is a
function that takes a builder to register cycle, fetch and session
parameters for this driver.

The source driver should also expose a property or static function
`validate`, which should take extendedd arguments via yargs `argv` or
Nightscout's extended settings for the `connect` plugin and return a list
of errors and validated configuration parameters.

#### Instantiating

Calling the source creation function takes a configuration and
returns an implementation of the vendor bound to the configuation.
This usually consists of a mixture of promises doing I/O, and
utilities to help transform data or interpret a gap or query
parameters.

Two promises are required for a.) resolving the configured credentials to
authenticated information, b.) resolving authenticated information to a
session.

The implementation of `generate_driver` should call `builder.support_session` mapping
these promises to `authenticate` and `authorize` properties of the
configuration parameter.  The entry point will call `generate_driver`.

In addition, to authentication and authorization, a third promise that takes a
session and resolves to a batch of collected data to be transformed is
required.  The implementation of `generate_driver` should call
`builder.register_loop` mapping this promise to the `frame.impl` property of
the configuration object in order to map inject it as the behavior for the
fetch machine.

For test/future development purposes, the entire bound implementation is
exported via `impl` object as well.  These promises are mixed with a variety of
utilities to align the schedule against previous readings.  Fortunately, the
structure of `impl` is independent from the requirements of builder  and
xstate, and can be reorganized according to project and author needs.

