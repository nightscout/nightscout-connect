

var crypto = require('crypto');

function AxiosTracer (axios, opts) {

  var finished = [ ];
  var pending = [ ];
  var queue = [ ];

  var request_instrument = (newReq) => {

    var uniqish = crypto.randomUUID();
    newReq.headers['x-axios-tracing'] = uniqish;
    newReq.headers['x-tracing-start'] = Date.now( );

    return newReq;
  };

  var on_request_error = (error) => {
    // if (error.request) { pending.push(error.request); }
    return Promise.reject(error);
  }

  axios.interceptors.request.use(request_instrument, on_request_error);

  var response_instrument = (newResp) => {
    // var request = newResp.request.getHeaders();
    // var tracer = newResp.config.headers['x-axios-tracing'];
    // var original = pending.filter((candidate) => candidate.headers['x-axios-tracing'] == tracer);
    // pending = pending.filter((candidate) => candidate.headers['x-axios-tracing'] != tracer);
    var log = {
      url: newResp.config.url,
      request: {
        headers: newResp.request.getHeaders( ),
        host: newResp.request.host,
        path: newResp.request.path,
        method: newResp.request.method,
        body: newResp.config.data
      },
      response: {
        statusCode: newResp.status,
        headers: newResp.headers,
        data: newResp.data,
      }
    };
    finished.push(log);
    if (newResp.config.url != newResp.request.url) {
      
    }
    return newResp;
  }
  var on_error_response = (error) => {
    if (error.response) {
    var newResp = error.response;
    var log = {
      url: newResp.config.url,
      request: {
        headers: newResp.request.getHeaders( ),
        host: newResp.request.host,
        path: newResp.request.path,
        method: newResp.request.method,
        body: newResp.config.data
      },
      response: {
        statusCode: newResp.status,
        headers: newResp.headers,
        data: newResp.data,
      }
    };
    finished.push(log);
     
    }
    return Promise.reject(error);
  }
  axios.interceptors.response.use(response_instrument, on_error_response);

  function generate ( ) {
    return finished;
  }

  function reset ( ) {
    finished = [ ];
  }

  generate.getGeneratedHar = generate;
  generate.reset = reset;

  return generate;
}
module.exports = AxiosTracer;
if (!module.parent) {
  console.log("MAIN");
  var axios = require('axios');
  var debug_one  = (x) => x;
  var debug_error = (error) => {
    if (error.response) {
      console.log("MIDDLEWARE ERROR", error.code, error.response.status, error.response.headers, error.response.data);
    }
    return Promise.reject(error);
  };
  axios.interceptors.response.use(debug_one, debug_error);
  axios.get('https://httpbin.org/status/401')
    .then(console.log.bind(console, 'SUCCESS'))
    .catch((error) => {
      // console.log("FOUND ERROR", error.code, error.response.status, error.response.headers, error.response.data);
      return error;
    });

}
