
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');

function createSessionMachine(impl, config) {
  var adapter = {
    maybeAuthenticate (context, event) {
      // TODO: get credentials
      // console.log('MAYBE AUTH with', context, event);
      return impl.authenticate();
    },
    maybeAuthorize (context, event) {
      // console.log('MAYBE AUTH/SESSION with', context, event);
      return impl.authorize(context.authInfo);
    },
    maybeRefresh (context, event) {
      if (impl.refresh && impl.refresh.call) {
        return impl.refresh(context.authInfo, context.session) ;
      }
    }
  };
  var sessionConfig = {
    services: {
      doAuthenticate: adapter.maybeAuthenticate,
      doAuthorize: adapter.maybeAuthorize,
      doRefresh: adapter.maybeRefresh,
    },
    actions: {
      maybe_refresh: actions.send((context, event) => {
        // console.log("MAYBE REFRESH ACTION", impl.refreshSession && impl.refreshSession.call, context, event);
        var type = "NO_REFRESH";
        if (impl.refresh && impl.refresh.call) {
          type = "REFRESHING";
        }
        return { type, data: event };
      })
    },
    guards: {
    },
    delays: {
      REFRESH_AFTER_SESSSION_DELAY: impl.delays.REFRESH_AFTER_SESSSION_DELAY || 1600,
      EXPIRE_SESSION_DELAY: impl.delays.EXPIRE_SESSION_DELAY || 2200,
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
          // actions.log()
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
      // '*': [ actions.log() ],
    },
    states: {
      Inactive: {
        entry: [
          // actions.log()
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
              // actions.log(),
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
                  // actions.log()
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

                // actions.log()
                ]
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
          // actions.log()
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
          REFRESHING: 'Refreshing',
          SESSION_REFRESH: {
            actions: [
              'maybe_refresh',
              // actions.log()
            ]
          },
          SESSION_REQUIRED: {
            actions: [
              actions.sendParent((context, event) => ({
                type: 'REUSED_ESTABLISHED_SESSION',
              })),
              // reuseActiveSession
              // actions.log("SESSION_REUSED!"),
              actions.sendParent((context, event) => ({ type: 'SESSION_RESOLVED', session: context.session})),
            ]
          },
        },
      },
      Refreshing: {
        invoke: {
          src: 'doRefresh',
          onDone: {
            target: 'Fresh.Established',
            actions: [actions.assign({
              session: (context, event) => event.data
            }),

            // actions.log()
            ]
          },
          onError: {
            // target: 'Error',
            actions: [

              actions.sendParent((context, event) => ({
                type: 'AUTHORIZATION_ERROR',
                data: event.data
              })),
              // actions.send((context, event) => ({type: "REJECT", data: event}))
              actions.sendParent("SESSION_EXPIRED")
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
          // actions.log()
        ]
      },
    }
  }, sessionConfig);
  return sessionMachine;
}

module.exports = createSessionMachine;
