

/*
* 
* https://github.com/nightscout/cgm-remote-monitor/blob/master/lib/server/bootevent.js
*
  // ctx.nightscoutConnect = require('nightscout-connect')(env, ctx);
  // ctx.nightscoutConnect.run( ).then(next).catch(next);
*/


function manage (env, ctx) {

  // source
  // output
  // env.extendedSettings.connect.source

  // TODO: consider subscribing to ctx.bus for start/stop.
  function handle ( ) { };
  handle.run = () => Promise.resolve(handle);
  handle.stop = () => Promise.resolve(handle);
  return handle;
}


module.exports = manage;
