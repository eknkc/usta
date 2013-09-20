var util = require("util");
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

module.exports = WorkerManager;
