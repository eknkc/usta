var util = require("util");
var cluster = require("cluster");
var events = require("events");

function WorkerManager() {
  if (!(this instanceof WorkerManager))
    return new WorkerManager();

  events.EventEmitter.call(this);

  var self = this;

  self.handlers = [];
  self.args = {};

  process.on("message", function(data) {
    if (data.usta_command == 'args') {
      self.args = data.payload;

      self.handlers.filter(function (handler) {
        return handler.pool == self.args["USTA_POOL"];
      }).forEach(function (handler) {
        process.nextTick(handler.handler);
      });

      delete self.handlers;
    }

    if (data.usta_command == 'ping') {
      process.send({
        usta_command: "ping"
      });
    }

    if (data.usta_command == 'disconnect') {
      self.emit("disconnect");
      self.disconnecting = true;
    }
  });

  process.send({
    usta_command: "online"
  });
}

util.inherits(WorkerManager, events.EventEmitter);

WorkerManager.prototype.isMaster = false;

WorkerManager.prototype.register = function(pool, handler) {
  if (!this.args["USTA_POOL"])
    this.handlers.push({ pool: pool, handler: handler });

  if (pool == this.args["USTA_POOL"])
    return process.nextTick(handler);
};

WorkerManager.prototype.status = function(next) {
  var callback = function(msg) {
    if (msg.usta_command == 'status') {
      next(null, msg.status);
      process.removeListener('message', callback);
    }
  };

  process.on('message', callback);
  process.send({ usta_command: 'status' });
}

WorkerManager.prototype.restart = function(options) {
  options = options || {};
  options.signal = false;
  this.kill(options);
};

WorkerManager.prototype.dispose = function(options) {
  options = options || {};
  options.signal = "DISPOSE";
  this.kill(options);
};

WorkerManager.prototype.kill = function(options) {
  options = options || {};
  var cmd = {};

  if (options.cluster)
    cmd.usta_command = "kill_cluster";
  else if (options.pool) {
    cmd.usta_command = "kill_pool";
    if (options.pool === true)
      cmd.pool = this.args["USTA_POOL"] || process.env["USTA_POOL"];
    else
      cmd.pool = options.pool;
  } else {
    cmd.usta_command = "kill";
    cmd.id = options.id || cluster.worker.id;
  }

  if (options.signal !== false)
    cmd.signal = options.signal || "SIGKILL";

  process.send(cmd);
};

module.exports = WorkerManager;
