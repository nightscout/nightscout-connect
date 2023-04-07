

function persistent (config, ctx) {

  function persists (batch) {
    console.log("INTERNAL PERSISTENCE", batch);
    return Promise.resolve(batch);

  }

  return persists;

}

module.exports = persistent;
