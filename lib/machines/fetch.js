const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');

function createFetchMachine (impl, config) {
  var adapter = {
    dataFetchService (context, event) {
      console.log('MAYBE FETCH', context, event);
      return impl.dataFromSesssion(context.session)
    },
    transformService (context, event) {
      if (impl.transformer && impl.transformer.call) {
        return Promise.resolve(impl.transformer(event.data));
      }
      return Promise.resolve(event.data);
    },
    persistService (context, event) {
      if (impl.persister && impl.persister.call) {
        return impl.persister(event.data);
      }
      return Promise.resolve(event.data);
    },
  };

  const fetchConfig = {
    actions: {
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
              actions.log('FETCHING')
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
              actions.log('TRANSFORMING')
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
        invoke: {
          src: 'persistService',
          onDone: {
            target: 'Success',
            actions: [ actions.assign({
                persisted: (context, event) => event.data
              }),
              actions.sendParent((context, event) => ({
                type: 'PERSISTED_DATA',
                data: event.data
              })),
              actions.log('PERSISTED')
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
        entry: actions.sendParent({type: "FRAME_SUCCESS"}),
        always: { target: 'Done' }
      },
      Error: {
        entry: actions.sendParent({type: "FRAME_ERROR"}),
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
