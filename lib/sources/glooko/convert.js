var moment = require('moment');
// Fixed-offset conversion, matching upstream. DST-correct conversion is a
// separate concern and is handled by #58.
function pumpToUtc (timestamp, timestampDelta) {
  return new Date(new Date(timestamp).getTime( ) + (timestampDelta || 0));
}


function generate_nightscout_treatments(batch, timestampDelta) {
      // Snack Bolus
      // Meal Bolus
      // BG Check
      // Correction Bolus
      // Carb Correction  
  /*
  var foods = entries['foods']['foods']; //ugh
  var insulins = entries['insulins']['insulins'];
  var pumpBoluses = entries['pumpBoluses']['normalBoluses']
  */
  const foods = batch.foods;
  const insulins = batch.insulins;
  const pumpBoluses = batch.normalBoluses;
  const scheduledBasals = batch.wideBasals || batch.scheduledBasals;
  
  var treatments = []
  
  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime()  + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime()  + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = insulins.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      

      insulin = result[0];
      if (insulin != undefined) {
        var i_date = moment(insulin.timestamp);
        treatment.eventType = 'Meal Bolus';
        // 4 hours * 60 minutes per hour * 60 seconds per minute * 1000 millseconds
        treatment.eventTime = new Date(i_date ).toISOString( );
        //treatment.eventTime = new Date(i_date).toISOString( );
        //treatment.eventTime = i_date.toISOString( );
        treatment.insulin = insulin.value;
        

        treatment.preBolus = moment.duration(moment(f_date).diff(moment(i_date))).asMinutes();
      } else {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_date ).toISOString( );
        //treatment.eventTime = new Date(f_date).toISOString( );
        //treatment.eventTime = f_date.toISOString( );
      }

      treatment.carbs = element.carbs;
      
      treatments.push(treatment);
      //console.log(treatment)

    });    
  }

  if (insulins) {
    insulins.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime() + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = foods.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      //console.log(result);
      if (result[0] == undefined) {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_date).toISOString( );
        treatment.insulin = element.value;
        //treatment.eventTime = f_date.toISOString( );
        treatments.push(treatment);
      }
    });    
  }

  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.pumpTimestamp);
      // A bolus with no carbs is a correction, not a meal. Labelling every
      // pump bolus 'Meal Bolus' makes the two indistinguishable in the log
      // and inflates anything that counts meals.
      var carbs = Number(element.carbsInput) || 0;
      treatment.eventType = carbs > 0 ? 'Meal Bolus' : 'Correction Bolus';
      treatment.eventTime = pumpToUtc(element.pumpTimestamp, timestampDelta).toISOString( );
      treatment.insulin = element.insulinDelivered;
      if (carbs > 0) treatment.carbs = carbs;
      // Boluses were the one collection not carrying their guid, so the dedup
      // filter could never match one and the wide fetch re-offered every bolus
      // in the window on every cycle. Identical re-posts collapsed, which hid
      // it - until the eventType changed and the same bolus landed a second
      // time under a different name.
      treatment.glookoGuid = element.guid;
      treatments.push(treatment);
    })
  }

  /*

  {
    "_id": "6481762cd06cbb6e6c06a6b7",
    "duration": 30,
    "timestamp": "2023-06-08T09:31:35+03:00",
    "absolute": 0,
    "rate": 0,
    "eventType": "Temp Basal",
    "medtronic": "mm://openaps/mm-format-ns-treatments/Temp Basal",
    "created_at": "2023-06-08T09:31:35.000+03:00",
    "enteredBy": "openaps://medtronic/"
  }
  
    {
      pumpTimestamp: '2023-06-15T12:07:30.000Z',
      pumpTimestampUtcOffset: '+00:00',
      pumpGuid: '520dd015-1b04-410b-8962-35d78b4a90e8',
      syncTimestamp: '2023-06-15T10:24:45.184Z',
      startTime: 43650,
      duration: 4582,
      segmentId: null,
      rate: 0,
      guid: 'dc335f52-0b66-11ee-ab49-0242ac110002',
      softDeleted: false,
      updatedAt: '2023-06-15T10:24:50.380Z',
      updatedBy: 'server'
    }
  */
  if (scheduledBasals) {
    scheduledBasals.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Temp Basal';
      treatment.created_at = pumpToUtc(element.pumpTimestamp, timestampDelta).toISOString( );
      treatment.rate = element.rate;
      treatment.absolute = element.rate;
      treatment.duration = Math.round(element.duration / 6) / 10;  // seconds -> minutes
      treatment.glookoGuid = element.guid;
      //treatment.eventTime = f_date.toISOString( );
      treatments.push(treatment);
    })
  }

  // Pod and reservoir events, straight from the pump's own record - this is
  // what feeds Nightscout's CAGE/IAGE counters. pod_activating is the moment
  // the new pod starts, which is what "site change" means for Omnipod.
  const pumpEvents = batch.pumpEvents;
  if (pumpEvents) {
    const EVENT_MAP = {
      pod_activating: 'Site Change',
      reservoir_change: 'Insulin Change',
      cgm_sensor_change: 'Sensor Start'
    };
    pumpEvents.forEach(function (element) {
      const eventType = EVENT_MAP[element.type];
      if (!eventType) { return; }
      var treatment = {};
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = eventType;
      // eventTime, not created_at - Nightscout only derives `mills` from the
      // former, and clients rely on mills to age a treatment
      treatment.eventTime = pumpToUtc(element.pumpTimestamp, timestampDelta).toISOString( );
      treatment.glookoGuid = element.guid;
      treatments.push(treatment);
    })
  }

  // Glooko alarms. `alarm_type` is always null - the machine-readable code
  // lives in `value`. Imported as Note (never Announcement) so they land on
  // the graph and in the log WITHOUT Nightscout raising notifications for
  // them: this is a record, not an alerting system.
  const ALARM_TEXT = {
    // device health - nothing else surfaces these
    omnipod_exit_close_loop: 'Left automated mode',
    omnipod_twelve_missing_egv: 'Pump lost CGM feed',
    omnipod_low_reservoir: 'Low reservoir',
    omnipod_pod_expiration: 'Pod expired',
    omnipod_pod_expiration_imminent: 'Pod expiring soon',
    omnipod_pod_expire_at_user_set_time: 'Pod expiry reminder',
    omnipod_pump_expired: 'Pod expired',
    dexcom_signal_loss: 'Sensor signal lost',
    dexcom_brief_sensor_issue: 'Brief sensor issue',
    // glucose thresholds - Dexcom Follow already alarms on these, so they are
    // here only to be drawn on the graph
    dexcom_low_glucose_alert: 'Low glucose',
    dexcom_high_glucose_alert: 'High glucose',
    dexcom_urgent_low_alert: 'Urgent low',
    dexcom_urgent_low_soon: 'Urgent low predicted',
    dexcom_falling_fast_alert: 'Falling fast',
    dexcom_rising_fast_alert: 'Rising fast',
    omnipod_urgent_low_glucose: 'Urgent low (pump)'
  };
  const DEVICE_CODES = {
    omnipod_exit_close_loop: 1, omnipod_twelve_missing_egv: 1,
    omnipod_low_reservoir: 1, omnipod_pod_expiration: 1,
    omnipod_pod_expiration_imminent: 1, omnipod_pod_expire_at_user_set_time: 1,
    omnipod_pump_expired: 1, dexcom_signal_loss: 1,
    dexcom_brief_sensor_issue: 1
  };
  const pumpAlarms = batch.pumpAlarms;
  if (pumpAlarms) {
    pumpAlarms.forEach(function (a) {
      if (!a.value) { return; }
      var text = ALARM_TEXT[a.value] || String(a.value).replace(/_/g, ' ');
      var treatment = {};
      treatment.eventType = 'Note';
      treatment.eventTime = pumpToUtc(a.pump_timestamp, timestampDelta).toISOString( );
      treatment.notes = text;
      treatment.enteredBy = 'glooko-alarm';
      treatment.glookoGuid = a.guid;
      // parsed by the display: severity, whether it is a device fault, and the
      // raw code so an unmapped one is still identifiable
      treatment.glookoAlarm = {
        code: a.value,
        severity: a.alarm_severity || 'alert',
        device: DEVICE_CODES[a.value] ? true : false
      };
      treatments.push(treatment);
    })
  }

  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments');

  return treatments;
}

// Glooko reports the pump's own insulin-on-board with each bolus and the
// treatment path throws it away, so Nightscout's IOB pill has nothing behind
// it. This turns the newest reading into a devicestatus record - the same
// shape Nightscout's own pump uploaders write, so the existing plugin picks
// it up with no further work.
//
// Only the newest bolus carrying a value is emitted: IOB is a snapshot, not a
// per-treatment fact, and posting one per bolus would fill devicestatus with
// stale figures. `created_at` is the bolus timestamp rather than now, so a
// batch seen twice produces an identical record instead of a false later
// reading.
function generate_nightscout_devicestatus (batch, timestampDelta) {
  const pumpBoluses = batch && batch.normalBoluses;
  if (!pumpBoluses || !pumpBoluses.length) return [ ];

  var newest = null;
  pumpBoluses.forEach(function (element) {
    if (element == null) return;
    var iob = Number(element.insulinOnBoard);
    if (!isFinite(iob) || iob < 0) return;            // absent, or not a number
    if (!element.pumpTimestamp) return;
    var when = pumpToUtc(element.pumpTimestamp, timestampDelta);
    if (!newest || when > newest.when) newest = { when: when, element: element, iob: iob };
  });
  if (!newest) return [ ];

  var stamp = newest.when.toISOString( );
  return [ {
    device: 'glooko' + (newest.element.pumpName ? ' (' + newest.element.pumpName + ')' : ''),
    created_at: stamp,
    pump: {
      clock: stamp,
      iob: { iob: newest.iob, timestamp: stamp }
    }
  } ];
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
module.exports.generate_nightscout_devicestatus = generate_nightscout_devicestatus;
