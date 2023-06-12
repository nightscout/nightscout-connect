const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');

// TOOD: reconsider naming Bus.
function createPollingMachine (sessionService, consumer, config) {
  /*
  consumer.{services,names,states}
  */
  const pollingConfig = {
    services: {
      sessionService,
      // storageService,
      // sessionService: service.sessionMachine,
      // cycleService: service.loopMachine,
      ...consumer.services
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
        /*
        invoke: {
          // TODO: remove/consider a diagnostics service instead
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
        */
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
              // actions.log(),
              actions.forwardTo('Session'),
            ],
          },

          /*
          * SESSION_RESOLVED and SESSION_ERROR need to be forwardTo the list
          * of session_consumers, several ways to potentially using actions.
          * one is to refer to a single action which has a closure around the
          * list, another is to create an actions list... maybe naming and
          * choosing all them to make it delarative?
          * // ...consumer.names.map((consumer) => actions.forwardTo(consumer))
          **/
          SESSION_RESOLVED: {
            actions: [
              // actions.log(),
              ...consumer.names.map((name) => actions.forwardTo(name))
            ],
          },
          SESSION_ERROR: {
            actions: [
              // actions.log(),
              ...consumer.names.map((name) => actions.forwardTo(name))
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
            // actions: actions.log()
          },
          STEP: {
          },
          STORE: {
            actions: [
              actions.forwardTo('OutputSink'),
            ],
          },
          FETCH_DATA: {
            actions: [
              actions.forwardTo('InputSink'),
            ],
          },
          DATA_AVAILABLE: {
            actions: [
              actions.pure((context, event) => {
                if (event.kind) {
                  return actions.forwardTo(event.kind)
                }
              }),
              // ...consumer.names.map((name) => actions.forwardTo(name))
            ],
          }

        },

        type: 'parallel',
        states: {
          Session: {
            invoke: {
              id: 'Session',
              src: 'sessionService',
            }
          },
          /*
          // should be a composition of the loops defined by the driver.
          */
          ...consumer.states,
          /*
          // should look like this:
          Cycle: {
            tags: ['cycle', 'operation'],
            invoke: {
              id: 'Cycle',
              src: 'cycleService'
            },
          }
          Output: {
            invoke: {
              id: 'Output',
              src: 'storageService',
            }
          },
          */
        }
      }
      
    }
  }).withConfig(pollingConfig);
  return pollingMachine;
}
module.exports = createPollingMachine;
