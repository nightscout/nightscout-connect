
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');

  function increment_field (name) {
    return actions.assign({
      [name]: (context, event) => context[name] + 1
    });
  }

module.exports = { increment_field };
