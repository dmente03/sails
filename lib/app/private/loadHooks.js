var _ = require('@sailshq/lodash');
var async = require('async');
var __hooks = require('../../hooks');
var defaultsDeep = require('merge-defaults');

module.exports = function(sails) {

  var Hook = __hooks(sails);

  // Keep an array of all the hook timeouts.
  // This way if a hook fails to load, we can clear all the timeouts at once.
  var hookTimeouts = [];

  /**
   * Resolve the hook definitions and then finish loading them
   *
   * @api private
   */
  return function initializeHooks(hooks, cb) {

    function prepareHook(id) {

      var hookPrototype = hooks[id];

      // Allow disabling of hooks by setting them to "false"
      if (hookPrototype === false || hookPrototype === 'false' || hooks[id.split('.')[0]] === false) {
        delete hooks[id];
        return;
      }

      // Check for invalid hook config
      if (hooks.userconfig && !hooks.moduleloader) {
        return cb('Invalid configuration:: Cannot use the `userconfig` hook w/o the `moduleloader` hook enabled!');
      }

      // Handle folder-defined modules (default to index.js)
      // Since a hook definition must be a function
      if (_.isObject(hookPrototype) && !_.isArray(hookPrototype) && !_.isFunction(hookPrototype)) {
        hookPrototype = hookPrototype.index;
      }

      if (!_.isFunction(hookPrototype)) {
        sails.log.error('Malformed hook! (' + id + ')');
        sails.log.error('Hooks should be a function with one argument (`sails`)');
        process.exit(1);
      }

      // Instantiate the hook
      var def = hookPrototype(sails);

      // Mix in an `identity` property to hook definition
      def.identity = id.toLowerCase();

      // If a config key was defined for this hook when it was loaded,
      // (probably because a user is overridding the default config key)
      // set it on the hook definition
      def.configKey = hookPrototype.configKey || def.identity;

      // New up an actual Hook instance
      hooks[id] = new Hook(def);
    }

    // Function to apply a hook's "defaults" obj or function
    function applyDefaults(hook) {
      // Get the hook defaults
      var defaults = (_.isFunction(hook.defaults) ?
                hook.defaults(sails.config) :
                hook.defaults) || {};
      // Replace the special __configKey__ key with the actual config key
      if (hook.defaults.__configKey__ && hook.configKey) {
        hook.defaults[hook.configKey] = hook.defaults.__configKey__;
        delete hook.defaults.__configKey__;
      }

      defaultsDeep(sails.config, defaults);
    }

    // Load a hook (bind its routes, load any modules and initialize it)
    function loadHook(id, cb) {

      var timeoutInterval = (sails.config[hooks[id].configKey || id] && sails.config[hooks[id].configKey || id]._hookTimeout) || sails.config.hookTimeout || 20000;
      var hookTimeout;
      if (id !== 'userhooks') {
        hookTimeout = setTimeout(function tooLong() {
          var hooksTookTooLongErr = 'The hook `'+id+'` is taking too long to load.\n' +
            'Make sure it is triggering its `initialize()` callback, ' +
            'or else set `sails.config.' + (hooks[id].configKey || id) +
            '._hookTimeout to a higher value (currently ' + timeoutInterval + ')';
          var err = new Error(hooksTookTooLongErr);
          err.code = 'E_HOOK_TIMEOUT';
          cb(err);
        }, timeoutInterval);
        hookTimeouts.push(hookTimeout);
      }
      hooks[id].load(function(err) {
        if (id !== 'userhooks') {
          clearTimeout(hookTimeout);
        }
        if (err) {
          // Clear all hook timeouts so that the process doesn't hang because
          // something is waiting for this failed hook to load.
          _.each(hookTimeouts, function(hookTimeout) {clearTimeout(hookTimeout);});
          if (id !== 'userhooks') {
            sails.log.error('A hook (`' + id + '`) failed to load!');
          }
          sails.emit('hook:' + id + ':error');
          return cb(err);
        }

        sails.log.verbose(id, 'hook loaded successfully.');
        sails.emit('hook:' + id + ':loaded');

        // Defer to next tick to allow other stuff to happen
        process.nextTick(cb);
      });
    }

    async.series(
      {

        // First load the moduleloader (if any)
        moduleloader: function(cb) {
          if (!hooks.moduleloader) {
            return cb();
          }
          prepareHook('moduleloader');
          applyDefaults(hooks['moduleloader']);
          hooks['moduleloader'].configure();
          loadHook('moduleloader', cb);
        },

        // Next load the user config (if any)
        userconfig: function(cb) {
          if (!hooks.userconfig) {
            return cb();
          }
          prepareHook('userconfig');
          applyDefaults(hooks['userconfig']);
          hooks['userconfig'].configure();
          loadHook('userconfig', cb);
        },

        // Next get the user hooks (if any), which will be
        // added to the list of hooks to load
        userhooks: function(cb) {
          if (!hooks.userhooks) {
            return cb();
          }
          prepareHook('userhooks');
          applyDefaults(hooks['userhooks']);
          hooks['userhooks'].configure();
          loadHook('userhooks', cb);
        },

        validate: function(cb) {
          if (hooks.controllers) {
            sails.log.debug('=================================================================================');
            sails.log.debug('Ignoring `controllers` hook:');
            sails.log.debug('As of Sails v1, `controllers` can no longer be disabled/enabled as hooks.');
            sails.log.debug('Instead, Sails core now understands controller actions as first-class citizens.');
            sails.log.debug('See the Sails v1.0 upgrade guide: http://sailsjs.com/upgrading');
            sails.log.debug('=================================================================================');
            delete hooks.controllers;
          }
          return cb();
        },

        // Prepare all other hooks
        prepare: function(cb) {
          async.each(_.without(_.keys(hooks), 'userconfig', 'moduleloader', 'userhooks'), function (id, cb) {
            prepareHook(id);
            // Defer to next tick to allow other stuff to happen
            process.nextTick(cb);
          }, cb);
        },

        // Apply the default config for all other hooks
        defaults: function(cb) {
          async.each(_.without(_.keys(hooks), 'userconfig', 'moduleloader', 'userhooks'), function (id, cb) {
            var hook = hooks[id];
            applyDefaults(hook);
            // Defer to next tick to allow other stuff to happen
            process.nextTick(cb);
          }, cb);
        },

        // Run configuration method for all other hooks
        configure: function(cb) {
          async.each(_.without(_.keys(hooks), 'userconfig', 'moduleloader', 'userhooks'), function (id, cb) {
            var hook = hooks[id];
            try {
              hook.configure();
            } catch (e) {
              return cb(e);
            }
            // Defer to next tick to allow other stuff to happen
            process.nextTick(cb);
          }, cb);
        },

        // Load all other hooks
        load: function(cb) {
          async.each(_.without(_.keys(hooks), 'userconfig', 'moduleloader', 'userhooks'), function (id, cb) {
            sails.log.silly('Loading hook: ' + id);
            loadHook(id, cb);
          }, cb);
        }
      },

      function hooksReady(err) {
        return cb(err);
      }
    );//</async.series>
  };
};
