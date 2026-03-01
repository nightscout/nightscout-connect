const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');
var debug = require('../debug');

function createFetchMachine (impl, config) {
  // Conditional logging actions based on debug mode
  var logAction = (label) => debug.enabled() ? actions.log(label) : 'noop';
  
  var adapter = {
    dataFetchService (context, event) {
      // console.log('MAYBE FETCH', context, event);
      return impl.dataFromSesssion(context.session, context.last_known)
    },
    transformService (context, event) {
      // console.log("TRANSFORMING service", context, event);
      if (impl.transformer && (impl.transformer.call)) {
        // console.log("TRANSFORMING XX", context, event);
        return Promise.resolve(impl.transformer(event.data, context.last_known));
      }
      return Promise.resolve(event.data);
    },
    gapService (context, event) {


      // console.log('GAP SERVICE');
      if (impl.persister && impl.persister.gap_for && (impl.persister.gap_for.then || impl.persister.gap_for.call)) {
        return impl.persister.gap_for( );
      }
      return Promise.resolve({ sgvs: null, treatments: null, profile: null, devicestatus: null });
    },
    persistService (context, event) {

      // console.log('PERSIST SERVICE');
      if (impl.persister && (impl.persister.then || impl.persister.call)) {
        return impl.persister(event.data);
      }
      return Promise.resolve(event.data);
    },
  };

  const fetchConfig = {
    actions: {
      noop: () => {},
      align_schedule: actions.pure((context, event) => {
        // console.log("ALIGN SCHEDULE ACTION", context, event);
        if (impl.align_schedule && (impl.align_schedule.call)) {
          var align_to = impl.align_schedule(event.data);
          if (align_to) {
            // console.log("SENDING ALIGN_TO to parent", event.data, align_to);
            return [actions.sendParent({type: "ALIGN_TO",
              data: align_to })];
          }
        }

      }),
    },
    services: {
      ...adapter,
      // dataFetchService: adapter.maybeFetch,
      // transformService: adapter.transformService,
      // persistService,
      // transformService: adapter.transformer
      // persistService: adapter.persister
    },
    guards: {
      shouldRetry: (context, event, transition) => {
        return context.retries < config.maxRetries
      }
    },
    delays: {
      WAIT_BEFORE_RETRY_DELAY: (context, event) => {
        var duration = config.frame_retry_duration(context.retries);
        // console.log("RETRY DELAY", duration, context, event);
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
      // last_record_updated_at: null,
      // gaps: null,
      last_known: null,
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
        // actions.log()
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
          RESOLVE: 'DetermineGaps',
          SESSION_ERROR: {
            target: 'Error',
          },
          SESSION_RESOLVED: {
            target: 'DetermineGaps',
            actions: [
              actions.assign({
                session: (context, event) => event.session
              }),
              // actions.log()
            ]
          },

          REJECT: 'Error',
        },
        // exit: { }
      },
      /*
      */
      DetermineGaps: {
        entry: [
          actions.sendParent((context, event) => ({
            type: 'GAP_ANALYSIS',
            data: event.data
          })),
        ],
        on: {
          LAST_KNOWN: {
            target: 'Fetching',
            actions: [ actions.assign({
                last_known: (context, event) => event.data
              }),
            ]
          }
        },
        invoke: {
          src: 'gapService',
          onDone: {
            target: 'Fetching',
            actions: [ actions.assign({
                last_known: (context, event) => event.data
              }),
            ]
          },
          onError: {
            target: 'Error',
            actions: [
            ]
          },
        },
      },
      Fetching: {
        entry: [
          actions.sendParent((context, event) => ({
            type: 'FETCH_SINCE',
            data: event.data
          })),
        ],
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
              logAction('FETCHING')
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
        invoke: {
          src: 'transformService',
          onDone: {
            target: 'Persisting',
            actions: [ actions.assign({
                transformed: (context, event) => event.data
              }),
              actions.sendParent((context, event) => ({
                type: 'TRANSFORMED_DATA',
                data: event.data
              })),
              logAction()
            ]
          },
          onError: {
            target: 'Error',
            actions: [

              actions.sendParent((context, event) => event),
            ]
          },
        },
        /*
        after: [{
          delay: 50,
        }],
        */
              on: {
          RESOLVE: 'Persisting',
          REJECT: 'Error'
        }
      
      },
      
      Persisting: {
        entry: [
          actions.sendParent((context, event) => ({
            type: 'STORE',
            data: event.data
          })),
        ],
        invoke: {
          src: 'persistService',
          onDone: {
            target: 'Success',
            actions: [ actions.assign({
                persisted: (context, event) => event.data
              }),
              "align_schedule",
              actions.sendParent((context, event) => ({
                type: 'PERSISTED_DATA',
                data: event.data,
                last_known: context.last_known
              })),
              // actions.log()
            ]
          },
          onError: {
            target: 'Error',
            actions: [

              actions.sendParent((context, event) => event),
            ]
          },
        },
        /*
        after: [{
          delay: 50,
          target: 'Success'
        }],
        */
              on: {
          RESOLVE: 'Success',
          REJECT: 'Error'
        }
      
      },
      Success: {
        entry: [
          actions.sendParent({type: "FRAME_SUCCESS"}),
          logAction("FRAME DONE"),
          logAction( ),
        ],
        always: { target: 'Done' }
      },
      Error: {
        entry: [
          logAction("FRAME ERROR"),
          logAction( ),
          actions.sendParent({type: "FRAME_ERROR"}),
        ],
        always: [
          {
            target: 'Retry',
            cond: {
              type: 'shouldRetry',
            },
          },
          { target: 'Done' }

        ]
      },
      Retry: {
        entry: [
          increment_field('retries'),
          actions.send('FRAME_BACKOFF')
        ],
        on: {
          RETRY: {
            target: 'Waiting',
          }
        },
      },
      Done: {
        type: 'final',
      }
      
    }
  }, fetchConfig);
  return fetchMachine;
}

module.exports = createFetchMachine;
