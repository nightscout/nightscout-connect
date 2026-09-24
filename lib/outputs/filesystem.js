

var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');
var fs = require('fs/promises');
var path = require('path');
var createLogger = require('../logging');

function filesystemOutput (config, axios) {
  var log = config.logger || createLogger(config.debug);
  log.debug("Filesystem output configured");
  var target = {
    label: config.label = 'ns-connect-out.log'
  , path_prefix: config.path_prefix || 'logs/'
  };

  var bookmark = null;

  function record_batch (batch) {
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];
    log.debug("Writing batch: " + entries.length + " entries, " + treatments.length + " treatments, " +
      devicestatus.length + " devicestatus, " + profiles.length + " profiles");

    var unique = Date.now( ).toString( );
    var pathname = path.join(target.path_prefix, unique + target.label);
    var buffer = JSON.stringify(batch, null, 2);
    return fs.open(pathname, 'w+').then((fh) => {
      fh.write(buffer).then(fh.close);
    }).then(function update_bookmark (settled) {
      return bookmark;
    });

  }

  return record_batch;
}

module.exports = filesystemOutput;
