var createLogger = require('../logging');
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');
var fs = require("fs");

function boundedMs(value, cap) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), cap) : 0;
}

function jitter(maximum) {
  var limit = boundedMs(maximum, 5 * 60 * 1000);
  return limit ? Math.floor(Math.random() * (limit + 1)) : 0;
}

function recent429s(context, now) {
  return (context.throttle_429_events || []).filter((time) => time >= now - 10 * 60 * 1000);
}

function createCycleMachine (services, config) {
  var log = config && config.logger || createLogger(false);
  var { capture } = config;
  var frameName = ['frame', config.name || ''].join('');
  const loopConfig = {
    services: {
      fetchService: services.fetchMachine,
    },
    actions: {
      // Capture is optional. Explicit no-ops avoid warnings on every cycle.
      resetCapture: capture
        ?
          ({tracker, runs, ...ctx}, event) => {
            tracker.reset( );
          }
        : () => {},
      startCapture: capture
        ?
          actions.assign({
            tracker: (context, event) => capture.start( )
          })
        : () => {},
      recordFrame: capture ? actions.pure(({ tracker, runs, ...ctx }, event) => {
        var harOutput = tracker.getGeneratedHar( );
        // Ensure the directory exists
        if (!fs.existsSync(capture.dir)) {
          fs.mkdirSync(capture.dir, { recursive: true });
        }
        fs.writeFileSync(`${capture.dir}/${frameName}-${runs}.har`, JSON.stringify(harOutput), 'utf-8');
      }) : () => {},
    },
    guards: {
    },
    delays: {
      MAIN_CYCLE_DELAY: (context, event) => {
        if (context.last_frame_error_status === 429 && config.throttle_backoff_per_error_ms) {
          var linear = boundedMs(config.throttle_backoff_per_error_ms * context.consecutive_429, 15 * 60 * 1000);
          return Math.max(linear, boundedMs(context.last_frame_retry_after_ms, 15 * 60 * 1000));
        }
        var duration = config.delay_per_frame_error(context.frames_missing);
        if (context.runs === 0) duration += jitter(config.startup_jitter_ms);
        // console.log('DELAY OPERATING', duration, context, event);
        return duration;

      },
      EXPECTED_DATA_INTERVAL_DELAY: (context, event) => {
        var boost = config.throttle_monitor_enabled && context.throttle_boost_until > Date.now() ? 60 * 1000 : 0;
        // console.log("SCHEDULE NEXT CYCLE", "lag", "last_known", context, event);
        // var last_glucose_at = new Date(last_known.sgvs.mills);
        // var count = Math.ceil(((new Date( )).getTime( ) - last_glucose_at) / (1000 * 60 * 5));
        if (context.align_to) {
          var diff = (context.align_to - new Date( ).getTime( ));
          // console.log("RESCHEDULE ALIGN_TO to", context.align_to, diff);
          if (Number.isFinite(diff) && diff > 0) return diff + jitter(config.expected_interval_jitter_ms) + boost;
        }
        return config.expected_data_interval_ms + jitter(config.expected_interval_jitter_ms) + boost;
      }
    }
  };
  const loopMachine = Machine({
    id: 'loop',
    initial: 'Init',
    context: {
      frames_missing: 0,
      last_frame_error_status: null,
      last_frame_retry_after_ms: 0,
      consecutive_429: 0,
      throttle_429_events: [ ],
      throttle_boost_until: 0,
      runs: 0,
      success: 0,
      data_packets: 0,
      data_errors: 0,
      frames: 0,
      align_to: null,
      frame_errors: 0,
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
          actions.assign({
            last_frame_error_status: (context, event) => event.status,
            last_frame_retry_after_ms: (context, event) => event.retry_after_ms || 0,
            consecutive_429: (context, event) => event.status === 429 ? context.consecutive_429 + 1 : 0,
            throttle_429_events: (context, event) => event.status === 429
              ? recent429s(context, Date.now()).concat(Date.now())
              : recent429s(context, Date.now()),
            throttle_boost_until: (context, event) => {
              if (!config.throttle_monitor_enabled || event.status !== 429) return context.throttle_boost_until;
              return recent429s(context, Date.now()).length >= 2
                ? Date.now() + 15 * 60 * 1000
                : context.throttle_boost_until;
            }
          }),
          // actions.log(),
        ]
      },
      FRAME_SUCCESS: {
        actions: [
          increment_field('frames'),
          actions.assign({
            frames_missing: 0,
            last_frame_error_status: null,
            last_frame_retry_after_ms: 0,
            consecutive_429: 0
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
          () => log.debug('Polling cycle started'),
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
          () => log.debug('Polling cycle scheduled'),
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
