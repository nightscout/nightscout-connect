
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

var testImpl = require('./lib/drivers/testable');
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
  
  var impl = testImpl.fakeFrame( );
  var frame_retry_duration = backoff( );
  var services = {
    maybeWaiting (context, event) {
      console.log("MAYBE WAIT?", context, event);
      return Promise.resolve();
    },
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
    resolveSession (context, event) {
      if (context.session) {
        console.log("REUSE SESSION", context.session);
        return Promise.resolve(context.session);
      }
      return impl.authFromCredentials()
        .then(impl.sessionFromAuth);

    },
    reuseSession (context, event) {
      return Promise.resolve(context.session);
    }
  };
  // need builder pattern to give to impl to customize machine
  // eg, refresh, priming, retry
  // for infinite loops, is the data interval expected to be 5 minutes,
  // or do things change if it's potentially several hours between
  // expected syncs?

  const sessionExpires = (context, event) => (cb) => {
    var sessionTTL = 1500 + (Math.random( ) * 750);
    console.log("tock setting up ticks");
    const interval = setTimeout(() => {
      cb({type: "SESSION_EXPIRED"});
    }, sessionTTL);

    return () => {
      clearTimeout(interval);
    }
  }

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
              src: services.maybeAuthenticate,
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
              src: services.maybeAuthorize,
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
          { delay: 1600,
            actions: [ actions.send("SESSION_REFRESH") ],
          },
          { delay: 2200,
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
  });


  const fetchMachine = (context, event) => {
    console.log("DEBUG INIT CHILD", context, event);
    var orig = context;
    return Machine({
    id: 'phase',
    initial: 'Idle',
    context: {
      retries: 0,
      duration: 0,
      session: context.current_session,
      diagnostics: {
      }
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
            delay: (context, event) => {
              var duration = frame_retry_duration(context.retries);
              console.log("CREATE RETRY DELAY", duration, context, event);
              return duration;

            }
          })
        ],
        /*
        invoke: {
          src: services.maybeWaiting,
          onDone: {
            target: 'Auth',
            // actions: actions.assign({ authInfo: (context, event) => event.data })
            actions: [
        ],
          },
          onError: {
            target: 'Error'
          }
        },
        */
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
          /*
          SESSION_REQUIRED: [
            { target: '.Established',
              cond: (context, event) => context.session
            },
            { target: '.Fresh' }
          ],
          */
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
          src: services.maybeFetch,
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
        entry: actions.sendParent({type: "FRAME_ERROR"}),
        always: [
          {
            target: 'Retry',
            cond: (context, event) => context.retries < 3
          },
          { target: 'Done' }

        ]
      },
      Retry: {
        entry: [
          actions.assign({
            retries: (context, event) => context.retries + 1
          }),
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
  });
  }
    
  const delay_per_frame_error = backoff({interval_ms: 2500 });
  const pollingMachine = Machine({
    id: 'Poller',
    initial: 'Idle',
    context: {
      retries: 0,
      runs: 0,
      success: 0,
      data_packets: 0,
      data_errors: 0,
      current_session: null,
      sessions: 0,
      // session_errors: 0,
      // reused_sessions: 0,
      authentications: 0,
      authentication_errors: 0,
      authorizations: 0,
      authorization_errors: 0,
      frames: 0,
      frame_errors: 0,
      frames_missing: 0,
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
          AUTHENTICATION_ERROR: {
            actions: [
              actions.assign({
                authentication_errors: (context, event) => context.authentication_errors + 1
              }),
              actions.log(),
            ]
          },
          AUTHORIZATION_ERROR: {
            actions: [
              actions.assign({
                authorization_errors: (context, event) => context.authorization_errors + 1
              }),
              actions.log(),
            ]
          },
          AUTHENTICATED: {
            actions: [
              actions.assign({
                authentications: (context, event) => context.authentications + 1
              }),
              actions.log(),
            ]
          },
          DATA_RECEIVED: {
            actions: [
              actions.assign({
                data_packets: (context, event) => context.data_packets + 1
              }),
              actions.log(),
            ]
          },
          DATA_ERROR: {
            actions: [
              actions.assign({
                data_errors: (context, event) => context.data_errors + 1
              }),
              actions.log(),
            ]
          },
          FRAME_ERROR: {
            actions: [
              actions.assign({
                frame_errors: (context, event) => context.frame_errors + 1,
                frames_missing: (context, event) => context.frames_missing + 1
              }),
              actions.log(),
            ]
          },
          FRAME_SUCCESS: {
            actions: [
              actions.assign({
                frames: (context, event) => context.frames + 1,
                frames_missing: 0
              }),
              actions.log(),
            ]
          },
          SESSION_REQUIRED: {
            actions: [
              actions.log(),
              actions.forwardTo('Session'),
            ],
          },
          SESSION_RESOLVED: {
            actions: [
              actions.log(),
              actions.forwardTo('frame'),
            ],
          },
          SESSION_ERROR: {
            actions: [
              actions.log(),
              actions.forwardTo('frame'),
            ],
          },
          SESSION_ESTABLISHED: {
            actions: [
              actions.assign({
                // current_session: (context, event) => event.session,
                sessions: (context, event) => context.sessions + 1,
                authorizations: (context, event) => context.authorizations + 1
              }),
            ],
          },
          /*
          FAKE: {
            actions: [
              actions.forwardTo('Session'),
              actions.sendTo('Session', {type: "DEBUG"}),
              actions.send({type: "DEBUG"}, {to: 'Session'}),
              // console.log.bind(console, "SESSION_ESTABLISHED did apply Session?"),
              // sessionExpires,
              actions.log(),
            ]
          },
          SESSION_EXPIRED: {
            actions: [
              actions.assign({
                current_session: null
              }),
              // actions.sendTo('frame', { type: 'SESSION_EXPIRED'}),
              // actions.sendTo('Session', (context, event) => event),
              actions.sendTo('frame', { type: 'SESSION_EXPIRED'}),
              // actions.sendTo('frame', { type: 'SESSION_REFRESH'}),
              actions.log(),
            ]
          },
          */
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
            /*
            actions: actions.assign({
              frame: (context, event) => {
                console.log('setting up new frame', context, event);
                // fetchMachine);
                return spawn(fetchMachine);
              }
            })
            */
          }
        },

        type: 'parallel',
        states: {
          Session: {
            invoke: {
              id: 'Session',
              src: sessionMachine,
              // onDone: { },
              // onError: { }
            }
          },
          Cycle: {
            initial: 'Ready',
            states: {
              Ready: {
                // entry: [ ]
                on: { },
                after: [
                  {
                    target: 'Operating',
                    delay: (context, event) => {
                      var duration = delay_per_frame_error(context.frames_missing);
                      console.log('DELAY OPERATING', duration, context, event);
                      return duration;

                    }
                  }
                ],
                // always: { target: 'Operating' }
              },
              Operating: {
                entry: [actions.log() ],
                invoke: {
                  // src: (context, event) { },
                  id: 'frame',
                  src: fetchMachine,

                  onDone: {
                    actions: [
                      actions.assign({
                        success: (context, event) => context.success + 1
                      }),
                      actions.log(),
                    ],
                    target: 'After',
                  },
                  onError: {
                    actions: [
                      actions.assign({
                        failures: (context, event) => context.failures + 1
                      }),
                      actions.log(),
                    ],
                    target: 'After',
                  },
                }
              },
              After: {
                entry: [
                  actions.assign({
                    runs: (context, event) => context.runs + 1
                  }),
                  actions.log(),
                ],
                // always: { target: 'Ready' },
                // Estimated data refresh interval
                after: [
                  {
                    target: 'Ready',
                    delay: 333
                  }
                ],
                on: { }
              }
            }
          }
        }
      }
      
    }
  });
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
  }, 60000 * 2);
}
