'use strict';

// Preserve the user-facing descriptions introduced by the consolidated pump
// event work. Unknown codes remain visible rather than silently disappearing.
const labels = {
  omnipod_exit_close_loop: 'Left automated mode',
  omnipod_twelve_missing_egv: 'Pump lost CGM feed',
  omnipod_low_reservoir: 'Low reservoir',
  omnipod_pod_expiration: 'Pod expired',
  omnipod_pod_expiration_imminent: 'Pod expiring soon',
  omnipod_pod_expire_at_user_set_time: 'Pod expiry reminder',
  omnipod_pump_expired: 'Pod expired',
  dexcom_signal_loss: 'Sensor signal lost',
  dexcom_brief_sensor_issue: 'Brief sensor issue',
  dexcom_low_glucose_alert: 'Low glucose',
  dexcom_high_glucose_alert: 'High glucose',
  dexcom_urgent_low_alert: 'Urgent low',
  dexcom_urgent_low_soon: 'Urgent low predicted',
  dexcom_falling_fast_alert: 'Falling fast',
  dexcom_rising_fast_alert: 'Rising fast',
  omnipod_urgent_low_glucose: 'Urgent low (pump)'
};
const deviceCodes = new Set([
  'omnipod_exit_close_loop',
  'omnipod_twelve_missing_egv',
  'omnipod_low_reservoir',
  'omnipod_pod_expiration',
  'omnipod_pod_expiration_imminent',
  'omnipod_pod_expire_at_user_set_time',
  'omnipod_pump_expired',
  'dexcom_signal_loss',
  'dexcom_brief_sensor_issue'
]);
function describe(code) {
  return {
    label: labels[code] || 'Alarm: ' + String(code).replace(/_/g, ' '),
    device: deviceCodes.has(code)
  };
}
module.exports = { describe };
