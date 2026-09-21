const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');
var fs = require("fs");

function createCycleMachine (services, config) {
  var { capture } = config;
  var frameName = ['frame', config.name || ''].join('');
  const loopConfig = {
    services: {
      fetchService: services.fetchMachine,
    },
    actions: {
      resetCapture: capture
        ?
          ({tracker, runs, ...ctx}, event) => {
            tracker.reset( );
          }
        : null,
      startCapture: capture
        ?
          actions.assign({
            tracker: (context, event) => capture.start( )
          })
        : null,
      recordFrame: capture ? actions.pure(({ tracker, runs, ...ctx }, event) => {
        var harOutput = tracker.getGeneratedHar( );
        // Ensure the directory exists
        if (!fs.existsSync(capture.dir)) {
          fs.mkdirSync(capture.dir, { recursive: true });
        }
        fs.writeFileSync(`${capture.dir}/${frameName}-${runs}.har`, JSON.stringify(harOutput), 'utf-8');
      }) : null,
    },
    guards: {
    },
    delays: {
      MAIN_CYCLE_DELAY: (context, event) => {
        var duration = config.delay_per_frame_error(context.frames_missing);
        // console.log('DELAY OPERATING', duration, context, event);
        return duration;

      },
      EXPECTED_DATA_INTERVAL_DELAY: (context, event) => {
        // console.log("SCHEDULE NEXT CYCLE", "lag", "last_known", context, event);
        // var last_glucose_at = new Date(last_known.sgvs.mills);
        // var count = Math.ceil(((new Date( )).getTime( ) - last_glucose_at) / (1000 * 60 * 5));
        if (context.align_to) {
          var diff = (context.align_to - new Date( ).getTime( ));
          // console.log("RESCHEDULE ALIGN_TO to", context.align_to, diff);
          return diff;
        }
        return config.expected_data_interval_ms;
      }
    }
  };
  const loopMachine = Machine({
    id: 'loop',
    initial: 'Init',
    context: {
      frames_missing: 0,
      runs: 0,
      success: 0,
      data_packets: 0,
      data_errors: 0,
      frames: 0,
      align_to: null,
      frame_errors: 0,
      frames_missing: 0,
    },
    on: {
      DATA_RECEIVED: {
        actions: [
          increment_field('data_packets'),
          // actions.log(),
        ]
      },
      DATA_ERROR: {
        actions: [
          increment_field('data_errors'),
          // actions.log(),
        ]
      },
      FRAME_ERROR: {
        actions: [
          increment_field('frame_errors'),
          increment_field('frames_missing'),
          // actions.log(),
        ]
      },
      FRAME_SUCCESS: {
        actions: [
          increment_field('frames'),
          actions.assign({
            frames_missing: 0
          }),
          // actions.log(),
        ]
      },
      // SESSION_RESOLVED and SESSION_ERROR should generally forward the frame
      // when the frame is in a final state, during the After phase below.
      SESSION_RESOLVED: {
        actions: [
          actions.forwardTo(frameName)
        ]
      },
      SESSION_ERROR: {
        actions: [
          actions.forwardTo(frameName)
        ]
      },
      SESSION_REQUIRED: {
        actions: [
          actions.sendParent((_, evt) => evt),
        ]
      },
      GAP_ANALYSIS: {
        actions: [
          actions.sendParent((_, evt) => evt),
        ]
      }
    },
    states: {
      Init: {
        entry: [
          'startCapture',
        ],
        after: [ { target: 'Ready' } ]
      },
      Ready: {
        // entry: [ ]
        on: { },
        after: [
          {
            target: 'Operating',
            delay: 'MAIN_CYCLE_DELAY',
          }
        ],
      },
      Operating: {
        entry: [
          actions.log('Operating Invoking'),
        ],
        on: {
          FETCH_DATA: {
            actions: [
              actions.sendParent((_, evt) => ({ kind: config.name, ...evt})),
            ]
          },
          ALIGN_TO: {
            actions: [
              // actions.log("ALIGN_TO SETTING"),
              actions.assign({
                align_to: (context, event) => event.data
              }),
              // actions.log("ALIGN_TO"),
            ]
          },
          PERSISTED_DATA: {
            actions: [
              (context, event) => {
                // console.log("INFORMED LAG", event.data);
              },
              actions.assign({
                last_known: (context, event) => event.data
              }),
              // actions.log("CYCLE INFORMED LAG DATA"),
            ]

          }
        },
        invoke: {
          id: frameName,
          src: 'fetchService',

          onDone: {
            actions: [
              increment_field('success'),
              actions.sendParent((_, evt) => evt),
              // 'log',
              // actions.log('Operating done'),
            ],
            target: 'After',
          },
          onError: {
            actions: [
              increment_field('failures'),
              actions.sendParent((_, evt) => evt),
              // 'log',
              // actions.log(),
            ],
            target: 'After',
          },
        }
      },
      After: {
        entry: [
          increment_field('runs'),
          actions.log('AFTER'),
          'recordFrame',
          'resetCapture',
        ],
        after: [
          {
            target: 'Ready',
            delay: 'EXPECTED_DATA_INTERVAL_DELAY',
            actions: [
              actions.assign({
                align_to: null,
              }),
            ]
          }
        ],
        on: {
          SESSION_RESOLVED: {
            actions: [
              // no-op to avoid forwarding event to a done frame.
            ]
          },
          SESSION_ERROR: {
            actions: [
              // no-op to avoid forwarding event to a done frame.
            ]
          },
        }
      }
    }
  }, loopConfig);
  return loopMachine;

}
module.exports = createCycleMachine;
