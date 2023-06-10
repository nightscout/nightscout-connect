

var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');
var fs = require('fs/promises');
var path = require('path');

function filesystemOutput (config, axios) {
  console.log("SETTING UP filesystemOutput", config);
  var target = {
    label: config.label = 'ns-connect-out.log'
  , path_prefix: config.path_prefix || 'logs/'
  };

  var bookmark = null;

  function record_batch (batch) {
    console.log("RECORD BATCH", batch);
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];

    var unique = Date.now( ).toString( );
    var pathname = path.join(target.path_prefix, unique + target.label);
    var buffer = JSON.stringify(batch, null, 2);
    return fs.open(pathname, 'w+').then((fh) => {
      fh.write(buffer).then(fh.close);
    }).then(function update_bookmark (settled) {
      console.log("UPDATE BOOKMARK FROM I/O", bookmark, settled);
      return bookmark;
    });

  }

  return record_batch;
}

module.exports = filesystemOutput;
