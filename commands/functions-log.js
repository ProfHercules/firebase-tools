'use strict';

var _ = require('lodash');
var api = require('../lib/api');
var Command = require('../lib/command');
var FirebaseError = require('../lib/error');
var gcp = require('../lib/gcp');
var getProjectId = require('../lib/getProjectId');
var logger = require('../lib/logger');
var requireAccess = require('../lib/requireAccess');
var requireConfig = require('../lib/requireConfig');
var RSVP = require('rsvp');

var POLL_INTERVAL = 1000; // 1 sec

function _pollLogs(authClient, projectId, filter, pos) {
  return new RSVP.Promise(function(resolve, reject) {
    function poll() {
      var nf = filter;
      if (pos.timestamp) {
        nf += ' timestamp>"' + pos.timestamp + '" '
      }
      if (pos.insertId) {
         nf += ' insertId>"' + pos.insertId + '" '
      }

      var promisedEntries = gcp.cloudlogging.entries(authClient, projectId, nf, 100, 'asc');
      RSVP.all([promisedEntries]).then(function(entries) {
        for (var i = 0; i < _.size(entries[0]); i++) {
          var entry = entries[0][i];
          logger.info(
            entry.timestamp,
            entry.severity.substring(0, 1),
            entry.resource.labels.function_name + ':',
            entry.textPayload);
          pos.timestamp = entry.timestamp
          pos.insertId = entry.insertId
        }
        setTimeout(poll, POLL_INTERVAL);
      }).catch(function(err) {
        return reject(err);
      });
    }
    poll();
  });
}

module.exports = new Command('functions:log')
  .description('read logs from GCF Kubernetes cluster')
  .option('-P, --project <project_id>', 'override the project ID specified in firebase.json')
  .option('-F, --function <function_name>', 'specify function name whose logs will be fetched')
  .option('-n, --lines <num_lines>', 'specify number of log lines to fetch')
  .option('-f, --follow', 'tail logs from GCF cluster')
  .before(requireConfig)
  .before(requireAccess)
  .action(function(options) {
    var filter = 'resource.type="cloud_function" ' +
                 'labels."cloudfunctions.googleapis.com/region"="us-central1" ';
    if (options.function) {
      filter += 'labels."cloudfunctions.googleapis.com/function_name"="' + options.function + '" ';
    }
    var projectId = getProjectId(options);
    var authClient;
    return api.getAccessToken().then(function(result) {
      return gcp.createClient(result.access_token);
    }).then(function(client) {
      authClient = client;
      return gcp.cloudlogging.entries(authClient, projectId, filter, options.lines || 35, 'desc');
    }).then(function(entries) {
      for (var i = _.size(entries); i-- > 0;) {
        var entry = entries[i];
        logger.info(
          entry.timestamp,
          entry.severity.substring(0, 1),
          entry.resource.labels.function_name + ':',
          entry.textPayload);
      }
      if (options.follow) {
        var pos = {}
        if (!_.isEmpty(entries)) {
          var lastEntry = _.last(entries)
          pos = {
            timestamp: lastEntry.timestamp,
            insertId: lastEntry.insertId
          }
        }
        return _pollLogs(authClient, projectId, filter, pos)
      } else if (_.isEmpty(entries)) {
        logger.info('No log entries found.');
      }
      return RSVP.resolve(entries);
    }).catch(function(err) {
      return RSVP.reject(new FirebaseError(
        'Failed to list log entries ' + err.message, {exit: 1}));
    });
  });
