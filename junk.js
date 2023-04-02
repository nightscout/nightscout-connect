
function testableDriver (opts, axios, impl) {
  console.log("SETTING UP TESTABLE DRIVER STUBS");
  /*
  function 
  settingsFrom(env);
  authFromCredentials(creds, settings)
  sessionFromAuth(auth, settings)
  datafromSesssion(session, settings)

  simulateBadCreds(ref)
  simulateGoodCreds(ref)
  simulateBadSession(ref)
  simulateGoodSession(ref)
  simulateBadData(ref)
  simulateGoodData(ref)
  */

}

function testableFrame ( ) {
  
}

function testableOnce ( ) {

}

function testableRepeatable (flow) {
  
}

function backoff (config) {
  var defaults = {
    interval_ms: 256,
    exponent_ceiling: 20,
    exponent_base: 2,
    use_random_slot: false
  };
  var opts = { ...config, ...defaults };
  var I = opts.interval_ms || 265;
  var C = opts.exponent_ceiling || 20;
  var B = opts.exponent_base || 2;
  function pick_random_slot(K) {
    var S = Math.floor(Math.random( ) * (K + 1))
    return S;
  }
  function maximum_time (K) {
    return K;
  }
  const choose = opts.use_random_slot ? pick_random_slot : maximum_time;
  function duration_for (attempt) {
    var K = Math.pow(B, Math.min(attempt, C)) - 1;
    var S = choose(K);
    var interval = I * S;
    return interval;
    // return I * Math.pow(B, attempt);
  }
  return duration_for;
}


function builder ( ) {

  var impl = { };
  var OperatingStates = {
  };

  var session_consumers = [ ];

  function framer (config) {
    return { services: impl, states: OperatingStates, session_consumers };

  }

  framer.support_session = (details) => {
    impl = { ...details, ...impl };
    return framer;
  }
  framer.register_loop = (name, cfg) => {
    session_consumers.push(name);
    serviceName = [name, 'Service'].join('');
    impl[serviceName] = (context, event) => cfg.frame.impl(context.session);
    OperatingStates[name] = {
      invoke: {
        id: name,
        src: serviceName,
        // src: cfg.frame.impl
      }
    };
    return framer;
  }
  return framer;
}

var testImpl = require('./testable_driver');
var axios = require('axios');

function testableLoop ( ) {

  // Available variables:
  // - Machine
  // - interpret
  // - assign
  // - send
  // - sendParent
  // - spawn
  // - raise
  // - actions
  // - XState (all XState exports)
  
  var make = builder( );
  var impl = testImpl.fakeFrame({ }, axios);

  var frame_retry_duration = backoff( );
  impl.generate_driver(make);

  // these results aren't quite right to use, ignored below.
  var built = make( );
  console.log("BUILDER OUTPUT", built);

  // should this interface be generated in the builder, defined on their own,
  // or explicitly defined by each driver?
  // they mahave difference needs for getters/setters on context?
  var services = {
    maybeAuthenticate (context, event) {
      console.log('MAYBE AUTH with', context, event);
      return impl.authFromCredentials();
    },
    maybeAuthorize (context, event) {
      console.log('MAYBE AUTH/SESSION with', context, event);
      return impl.sessionFromAuth(context.authInfo);
    },
    maybeFetch (context, event) {
      console.log('MAYBE FETCH', context, event);
      return impl.dataFromSesssion(context.session)
    },
  };

  // need builder pattern to give to impl to customize machine
  // eg, refresh, priming, retry
  // multiple loops, eg daily, hourly, 5 minute
  // for infinite loops, is the data interval expected to be 5 minutes,
  // or do things change if it's potentially several hours between
  // expected syncs?


  var sessionConfig = {
    services: {
      doAuthenticate: services.maybeAuthenticate,
      doAuthorize: services.maybeAuthorize,
    },
    actions: {
    },
    guards: {
    },
    delays: {
      REFRESH_AFTER_SESSSION_DELAY: 1600,
      EXPIRE_SESSION_DELAY: 2200,
    }
  };
  const sessionMachine = Machine({
    id: 'session',
    initial: 'Inactive',
    context: {
      session: null,
      authInfo: null,
    },
    on: {
      DEBUG: {
        actions: [
          actions.log()
        ]
      },
      // TODO: rename SET_SESSION?
      SET_SESSION: {
        target: 'Active',
        actions: [
          actions.assign({
            session: (context, event) => event.data
          }),
          actions.log()
        ]
      },
      RESET: {
        target: 'Inactive',
        actions: [
          actions.assign({
            session: null
          }),
        ]
      },
      SESSION_REQUIRED: {
        target: 'Fresh'
      },
      '*': [ actions.log() ],
    },
    states: {
      Inactive: {
        entry: [
          actions.log()
        ]
      },
      Fresh: {
        initial: 'Authenticating',
        on: {
          SESSION_REQUIRED: {
            // no-op
          },
          SESSION_RESOLVED: {
            target: 'Active',
          },
          REJECT: {
            target: 'Fresh.Error'
          },
        },
        states: {
          Error: {
            entry: [
              actions.sendParent((context, event) => ({
                type: 'SESSION_ERROR',
                // data: event.data
              })),
              actions.log(),
              actions.send("RESET")
            ],
          },
          Authenticating: {
            invoke: {
              src: 'doAuthenticate',
              onDone: {
                target: 'Authorizing',
                actions: [actions.assign({
                    authInfo: (context, event) => event.data
                  }),

                  actions.sendParent((context, event) => ({
                    type: 'AUTHENTICATED',
                    data: event.data
                  })),
                  actions.log()
                ]
              },
              onError: {
                // target: '.Error',
                actions: [

                  actions.sendParent((context, event) => ({
                    type: 'AUTHENTICATION_ERROR',
                    data: event.data
                  })),
                  actions.send((context, event) => ({type: "REJECT", data: event}))
                ]
              }
            },
            on: {
              RESOLVE: 'Authorizing',
              // REJECT: 'Error'
            }
          
          },
          Authorizing: {
            invoke: {
              // maybeAuthorize
              src: 'doAuthorize',
              onDone: {
                target: 'Established',
                actions: [actions.assign({
                  session: (context, event) => event.data
                }),

                actions.log()]
              },
              onError: {
                // target: 'Error',
                actions: [

                  actions.sendParent((context, event) => ({
                    type: 'AUTHORIZATION_ERROR',
                    data: event.data
                  })),
                  actions.send((context, event) => ({type: "REJECT", data: event}))
                ]
              },
            },
                  on: {
              // RESOLVE: 'Fetching',
              // REJECT: 'Error'
            }
          
          },
          Established: {
            entry: [
                actions.sendParent((context, event) => ({
                  type: 'SESSION_ESTABLISHED',
                  session: context.session
                })),
                actions.sendParent((context, event) => ({
                  type: "SESSION_RESOLVED",
                  session: context.session
                })),
                actions.send((context, event) => ({type: "SESSION_RESOLVED", data: context.session }))
            ],
            // always: { target: 'session.Active' }
          },
        }
      },
      Active: {
        entry: [
          actions.log()
        ],
        after: [
          { delay: 'REFRESH_AFTER_SESSSION_DELAY',
            actions: [ actions.send("SESSION_REFRESH") ],
          },
          { delay: 'EXPIRE_SESSION_DELAY',
          target: 'Expired'
          }
        ],
        on: {
          SESSION_REFRESH: {
            actions: [
              actions.log()
            ]
          },
          SESSION_REQUIRED: {
            actions: [
              actions.sendParent((context, event) => ({
                type: 'REUSED_ESTABLISHED_SESSION',
              })),
              // reuseActiveSession
              actions.sendParent((context, event) => ({ type: 'SESSION_RESOLVED', session: context.session})),
            ]
          },
        },
      },
      Expired: {
        entry: [
          // actions.send("SESSION_EXPIRED"),
          actions.assign({
            session: null
          }),
          actions.sendParent("SESSION_EXPIRED"),
          actions.log()
        ]
      },
    }
  }, sessionConfig);


  const fetchConfig = {
    actions: {
    },
    services: {
      dataFetchService: services.maybeFetch
    },
    guards: {
      shouldRetry: (context, event, transition) => {
        return context.retries < transition.cond.maxRetries
      }
    },
    delays: {
      WAIT_BEFORE_RETRY_DELAY: (context, event) => {
        var duration = frame_retry_duration(context.retries);
        console.log("RETRY DELAY", duration, context, event);
        return duration;

      }

    },
  };

  const fetchMachine = Machine({
    id: 'phase',
    initial: 'Idle',
    context: {
      retries: 0,
      duration: 0,
      session: null,
      diagnostics: {
      }
    },
    meta: {
      foo: 'machineBarMeta',
    },
    on: {
      SESSION_EXPIRED: [
        actions.assign({
          session: null
        }),
        actions.log()
      ],
      FRAME_BACKOFF: {
        target: 'Waiting',
        actions: [ ],
      }
    },
    states: {
      Idle: {
        entry: [actions.send("call"),
          actions.assign({
            started: (context, event) => Date.now( )
          })
        ],
        on: {
          call: 'Waiting'
        }
      },
      Waiting: {
        entry: [ actions.assign({
            startedWaiting: (context, event) => Date.now( )
          }),

          actions.send({ type: 'CONTINUE' }, {
            delay: 'WAIT_BEFORE_RETRY_DELAY',
          })
        ],
        after: [ ],
        exit: [
          actions.assign({
            endedWaiting: (context, event) => Date.now( ),
            elapsedWaiting: (context, event) => Date.now( ) - context.startedWaiting
          })
        ],
        on: {
          RESOLVE: 'Auth',
          CONTINUE: 'Auth',
          REJECT: 'Error'
        }
      },
      Auth: {
        entry: actions.sendParent('SESSION_REQUIRED'),
        on: {
          RESOLVE: 'Fetching',
          SESSION_ERROR: {
            target: 'Error',
          },
          SESSION_RESOLVED: {
            target: 'Fetching',
            actions: [
              actions.assign({
                session: (context, event) => event.session
              }),
              actions.log()
            ]
          },

          REJECT: 'Error',
        },
        // exit: { }
      },
      /*
      */
      
      Fetching: {
        invoke: {
          src: 'dataFetchService',
          onDone: {
            target: 'Transforming',
            actions: [ actions.assign({
                data: (context, event) => event.data
              }),
              actions.sendParent((context, event) => ({
                type: 'DATA_RECEIVED',
                data: event.data
              })),
              actions.log()
            ]
          },
          onError: {
            target: 'Error',
            actions: [

              actions.sendParent((context, event) => ({
                type: 'DATA_ERROR',
                data: event.data
              })),
            ]
          },
        },
              on: {
          RESOLVE: 'Transforming',
          REJECT: 'Error'
        }
      
      },
      
      Transforming: {
        after: [{
          delay: 50, target: 'Persisting'
        }],
              on: {
          RESOLVE: 'Persisting',
          REJECT: 'Error'
        }
      
      },
      
      Persisting: {
        after: [{
          delay: 50, target: 'Success'
        }],
              on: {
          RESOLVE: 'Success',
          REJECT: 'Error'
        }
      
      },
      Success: {
        // type: 'final',
        entry: actions.sendParent({type: "FRAME_SUCCESS"}),
        always: { target: 'Done' }
      },
      Error: {
        // type: 'final',
        meta: {
          foomaxErrors: 3,
        },
        entry: actions.sendParent({type: "FRAME_ERROR"}),
        always: [
          {
            target: 'Retry',
            // cond: (context, event) => context.retries < 3
            cond: {
              type: 'shouldRetry',
              maxRetries: 3,
            },
          },
          { target: 'Done' }

        ]
      },
      Retry: {
        entry: [
          increment_field('retries'),
          /*
          actions.assign({
            retries: (context, event) => context.retries + 1
          }),
          */
          actions.send('FRAME_BACKOFF')
        ],
        on: {
          RETRY: {
            target: 'Waiting',
          }
        },
        // after: [ ],
      },
      Done: {
        type: 'final',
      }
      
    }
  }, fetchConfig);
    
  const delay_per_frame_error = backoff({interval_ms: 2500 });
  function increment_field (name) {
    return actions.assign({
      [name]: (context, event) => context[name] + 1
    });
  }

  const loopConfig = {
    services: {
      fetchService: fetchMachine,
    },
    actions: {
    },
    guards: {
    },
    delays: {
      MAIN_CYCLE_DELAY: (context, event) => {
        var duration = delay_per_frame_error(context.frames_missing);
        console.log('DELAY OPERATING', duration, context, event);
        return duration;

      },
      EXPECTED_DATA_INTERVAL_DELAY: 333
    }
  };
  const loopMachine = Machine({
    id: 'loop',
    initial: 'Ready',
    context: {
      frames_missing: 0,
      runs: 0,
      success: 0,
      data_packets: 0,
      data_errors: 0,
      frames: 0,
      frame_errors: 0,
      frames_missing: 0,
    },
    on: {
      DATA_RECEIVED: {
        actions: [
          increment_field('data_packets'),
          actions.log(),
        ]
      },
      DATA_ERROR: {
        actions: [
          increment_field('data_errors'),
          actions.log(),
        ]
      },
      FRAME_ERROR: {
        actions: [
          increment_field('frame_errors'),
          increment_field('frames_missing'),
          actions.log(),
        ]
      },
      FRAME_SUCCESS: {
        actions: [
          increment_field('frames'),
          actions.assign({
            frames_missing: 0
          }),
          actions.log(),
        ]
      },
      SESSION_RESOLVED: {
        actions: [
          actions.forwardTo('frame')
        ]
      },
      SESSION_ERROR: {
        actions: [
          actions.forwardTo('frame')
        ]
      },
      SESSION_REQUIRED: {
        actions: [
          actions.sendParent((_, evt) => evt),
        ]
      }
    },
    states: {
      Ready: {
        // entry: [ ]
        on: { },
        after: [
          {
            target: 'Operating',
            delay: 'MAIN_CYCLE_DELAY',
          }
        ],
        // always: { target: 'Operating' }
      },
      Operating: {
        entry: [actions.log() ],
        invoke: {
          // src: (context, event) { },
          id: 'frame',
          src: 'fetchService',
          // fetchService
          // src: fetchMachine,

          onDone: {
            actions: [
              increment_field('success'),
              actions.sendParent((_, evt) => evt),
              'log',
              actions.log(),
            ],
            target: 'After',
          },
          onError: {
            actions: [
              increment_field('failures'),
              actions.sendParent((_, evt) => evt),
              'log',
              actions.log(),
            ],
            target: 'After',
          },
        }
      },
      After: {
        entry: [
          increment_field('runs'),
          actions.log(),
        ],
        // always: { target: 'Ready' },
        // Estimated data refresh interval
        // correct time is expected data cycle time + mobile_lag + jitter
        after: [
          {
            target: 'Ready',
            delay: 'EXPECTED_DATA_INTERVAL_DELAY'
          }
        ],
        on: { }
      }
    }
  }, loopConfig);

  const pollingConfig = {
    services: {
      sessionService: sessionMachine,
      cycleService: loopMachine,
    },
    actions: {
    },
    guards: {
    },
    delays: {
    }
  };

  const pollingMachine = Machine({
    id: 'Poller',
    initial: 'Idle',
    context: {
      retries: 0,

      sessions: 0,
      // session_errors: 0,
      // reused_sessions: 0,
      authentications: 0,
      authentication_errors: 0,
      authorizations: 0,
      authorization_errors: 0,

      failures: 0,
      // stale/ailing/failed
    },
    states: {
      Idle: {
        on: {
          START: 'Running'
        },
      },
      Running: {
        // entry: [ actions.send("STEP"), ],
        invoke: {
          // Hello World test/exercise. Helps evaluate tempo when looking at
          // output.
          // tickDemo
          src: (context) => (cb) => {
            console.log("tock setting up ticks");
            const interval = setInterval(() => {
              cb("TICK");
            }, 1000);

            return () => {
              clearInterval(interval);
            }
          }
        },
        on: {
          // '': { target: '.Ready' },
          DEBUG: {
            actions: [
              actions.log(),
            ]
          },
      // should session track it's own telemetry
      AUTHENTICATION_ERROR: {
        actions: [
          increment_field('authentication_errors'),
          actions.log(),
        ]
      },
      AUTHORIZATION_ERROR: {
        actions: [
          increment_field('authorization_errors'),
          actions.log(),
        ]
      },
      AUTHENTICATED: {
        actions: [
          increment_field('authentications'),
          actions.log(),
        ]
      },
          SESSION_REQUIRED: {
            actions: [
              actions.log(),
              actions.forwardTo('Session'),
            ],
          },

          /*
          * SESSION_RESOLVED and SESSION_ERROR need to be forwardTo the list
          * of session_consumers, several ways to potentially using actions.
          * one is to refer to a single action which has a closure around the
          * list, another is to create an actions list... maybe naming and
          * choosing all them to make it delarative?
          * // ...built.session_consumers.map((consumer) => actions.forwardTo(consumer))
          **/
          SESSION_RESOLVED: {
            actions: [
              actions.log(),
              (context, event, state, fourth) => {
                // console.log("FORWARD TO FRAME", context, event, state, fourth);
              },
              // actions.forwardTo('frame'),
              actions.forwardTo('Cycle'),
            ],
          },
          SESSION_ERROR: {
            actions: [
              actions.log(),
              // actions.forwardTo('frame'),
              actions.forwardTo('Cycle'),
            ],
          },
          SESSION_ESTABLISHED: {
            actions: [
              increment_field('sessions'),
              increment_field('authorizations'),
            ],
          },
          FRAME_DONE: {
            actions: [actions.log(),
              actions.send("STEP"),
            ],
          },
          STOP: 'Idle',
          TICK: {
            actions: actions.log()
          },
          STEP: {
          },

        },

        type: 'parallel',
        states: {
          Session: {
            invoke: {
              id: 'Session',
              src: 'sessionService',
              // src: sessionMachine,
              // onDone: { },
              // onError: { }
            }
          },
          /*
          // does not work, yet
          // should be a composition of the loops defined by the driver.
          ...built.states
          */
          // equivalent helloworld using our fast simulation of a single five minute cycle.
          // this allows watching the agent go through all states rather quickly.
          Cycle: {
            tags: ['cycle', 'operation'],
            invoke: {
              id: 'Cycle',
              src: 'cycleService'
            },
          }
        }
      }
      
    }
  }).withConfig(pollingConfig);
  return pollingMachine;
}

const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
module.exports.testableLoop = testableLoop;

if (!module.parent) {
  var things = testableLoop( );
  console.log(things);
  var actor = interpret(things);
  actor.start( );
  actor.send({type: 'START'});
  setTimeout(( ) => {
  actor.send({type: 'STOP'});
  }, 60000 * 5);
}
