const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var { increment_field } = require('./utils');

function createCycleMachine (services, config) {
  var frameName = ['frame', config.name || ''].join('');
  const loopConfig = {
    services: {
      fetchService: services.fetchMachine,
    },
    actions: {
    },
    guards: {
    },
    delays: {
      MAIN_CYCLE_DELAY: (context, event) => {
        var duration = config.delay_per_frame_error(context.frames_missing);
        console.log('DELAY OPERATING', duration, context, event);
        return duration;

      },
      EXPECTED_DATA_INTERVAL_DELAY: config.expected_data_interval_ms || 333
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
          id: frameName,
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
        on: {
          SESSION_RESOLVED: {
            actions: [
              // no-op
            ]
          },
          SESSION_ERROR: {
            actions: [
              // no-op
            ]
          },
        }
      }
    }
  }, loopConfig);
  return loopMachine;

}
module.exports = createCycleMachine;
