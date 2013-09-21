var cluster = require("cluster");
var path = require("path");
var util = require("util");
var events = require("events");

function MasterManager() {
  if (!(this instanceof MasterManager))
    return new MasterManager();

  this.pools = {};

  this.options = {
    silent: false
  };
}

function Pool(manager, name, options) {
  events.EventEmitter.call(this);

  this.manager = manager;
  this.name = name;
  this.size = options.size || 0;
  this.args = options.args || {};
  this.env = options.env || {};
  this.strict = options.strict;

  this.workers = [];

  this.heartbeatTimeout = options.heartbeatTimeout || 10000;

  this.ttl = options.ttl || 0;
  this.ttlVariance = typeof options.ttlVariance === 'undefined' ? 0.25 : options.ttlVariance;

  this.killDelay = typeof options.killDelay ===  'undefined' ? 30000 : options.killDelay;
  this.restartDelay = typeof options.restartDelay ===  'undefined' ? 2000 : options.restartDelay;

  this.args["USTA_POOL"] = this.env["USTA_POOL"] = this.name;

  for (var i = this.size - 1; i >= 0; i--) {
    this.spawn();
  };
}

util.inherits(Pool, events.EventEmitter);

function Worker(pool, nativeWorker) {
  events.EventEmitter.call(this);

  var self = this;

  self.pool = pool;
  self.worker = nativeWorker;
  self.worker.shell = self;
  self.id = self.worker.id;
  self.pid = self.worker.process.pid;

  self.create = new Date();
  self.hearbeat = new Date();

  self.log("spawned");

  self.worker.once("online", function () {
    self.log("online");
    self.emit("online");
  });

  self.worker.on("message", function (message) {
    self.hearbeat = new Date();

    if (message.usta_command === 'online') {
      self.online = true;

      self.worker.send({
        usta_command: "args",
        payload: self.pool.args
      });
    } else if (message.usta_command) {
      self.emit('command', {
        command: message.usta_command,
        data: message
      });
    }
  });

  self.worker.on("disconnect", function () {
    self.log("disconnected.");

    self.disconnecttimer = setTimeout(function () {
      self.log("force shutdown.");
      self.kill("SIGKILL")
    }, 5000);
  });

  self.worker.on("exit", function () {
    self.log("exited");

    self.exited = true;
    delete self.worker.shell;

    clearTimeout(self.disconnecttimer);
    self.emit("exit");
  });

  Object.defineProperty(self, "process", {
    get: function() { return self.worker.process; },
    configurable: false,
    enumerable: false
  });
};

util.inherits(Worker, events.EventEmitter);

Worker.prototype.setHeartbeat = function(timeout) {
  var self = this;

  self.worker.on("exit", function () {
    clearInterval(self.heartbeatTimer);
  });

  self.heartbeatTimer = setInterval(function() {
    function clear() {
      clearInterval(self.heartbeatTimer);
    }

    if (!self.process.connected)
      return clear();

    if (self.hearbeat.getTime() < Date.now() - timeout) {
      self.log("exiting due to heartbeat timeout");
      self.kill("SIGKILL")
      return clear();
    }

    self.worker.send({ usta_command: 'ping' });
  }, Math.floor(timeout / 4));
};

Worker.prototype.ttl = function(ttl) {
  var self = this;

  self.worker.on("exit", function () {
    clearTimeout(self.ttlTimer);
  });

  self.ttlTimer = setTimeout(function () {
    if (self.exited)
      return;

    self.log("exiting due to ttl");
    self.restart();
  }, ttl);
};

Worker.prototype.restart = function() {
  var self = this;

  if (self.restarting || self.exited)
    return;

  self.restarting = true;
  self.log("restarting");

  function disconnect() {
    if (self.worker.process.connected) {
      self.worker.send({
        usta_command: "disconnect"
      });

      self.worker.disconnect();
    }

    self.killtimer = setTimeout(function () {
      self.log("force shutdown");
      self.kill("SIGKILL")
    }, self.pool.killDelay)
  }

  if (self.pool.strict)
    return disconnect();

  var replacement = self.pool.spawn();

  replacement.once("online", function() {
    self.replaced = true;
    disconnect();
  });
};

Worker.prototype.kill = function(signal) {
  if (this.exited)
    return;

  if (signal) {
    if (signal === 'DISPOSE') {
      this.disposed = true;
      signal = 'SIGKILL';
    }

    this.worker.process.kill(signal);
  } else
    this.restart();
};

Worker.prototype.log = function(log) {
  this.pool.log("Worker " + this.worker.id + " | " + log);
};

Pool.prototype.spawn = function() {
  var self = this;

  var worker = new Worker(this, cluster.fork(self.env));

  worker.on("exit", function () {
    clearTimeout(worker.killtimer);

    for (var i = self.workers.length - 1; i >= 0; i--) {
      if (self.workers[i].id == worker.id) {
        self.workers.splice(i, 1);
        break;
      }
    };

    if (!worker.replaced && !worker.disposed) {
      var age = Date.now() - worker.create.getTime();

      if (age < self.restartDelay) {
        self.log("fast restart. backing off");
        setTimeout(function() { self.spawn(); }, self.restartDelay - age);
      } else
        self.spawn();
    }

    if (worker.disposed)
      self.size--;
  });

  worker.on("command", function (command) {
    self.emit("command", {
      worker: worker,
      command: command.command,
      data: command.data
    });
  })

  if (self.heartbeatTimeout)
    worker.setHeartbeat(self.heartbeatTimeout);

  if (self.ttl)
    worker.ttl(self.ttl + (self.ttl * self.ttlVariance * (1 + Math.random())));

  self.workers.push(worker);
  return worker;
};

Pool.prototype.kill = function(signal) {
  this.workers.slice().forEach(function (worker) {
    worker.kill(signal);
  });
};

Pool.prototype.log = function(log) {
  this.manager.log("Pool " + this.name + " | " + log);
};

MasterManager.prototype.isMaster = true;

MasterManager.prototype.setup = function(options) {
  this.config(options);

  cluster.setupMaster({
    silent: this.options.silent,
    exec: this.options.exec,
    args: this.options.args || []
  });

  return this;
};

MasterManager.prototype.config = function(opt, value) {
  if (typeof opt == 'object') {
    Object.keys(opt).forEach(function (key) {
      this.config(key, opt[key]);
    }, this);

    return;
  }

  if (typeof value == 'undefined')
    return this.options[opt];

  return this.options[opt] = value;
};

MasterManager.prototype.pool = function(name, options) {
  var self = this;

  if (self.pools[name])
    return self.pools[name];

  var pool = new Pool(self, name, options);
  self.pools[name] = pool;

  pool.on("command", function(cmd) {
    if (cmd.command == 'kill') {
      var worker = cluster.workers[cmd.data.id];

      if (worker && worker.shell) {
        worker.shell.log("killed by " + cmd.worker.id)
        worker.shell.kill(cmd.data.signal);
      }
    }

    if (cmd.command == 'kill_pool') {
      var pool = self.pools[cmd.data.pool];
      pool.log("killed by " + cmd.worker.id);
      pool.kill(cmd.data.signal);
    }

    if (cmd.command == 'kill_cluster') {
      self.log("killed by " + cmd.worker.id);
      self.kill(cmd.data.signal);
    }
  });

  return self;
};

MasterManager.prototype.kill = function(signal) {
  var self = this;

  Object.keys(self.pools).forEach(function (pool) {
    self.pools[pool].kill(signal);
  });
};

MasterManager.prototype.log = function(log) {
  console.log("Master | " + log);
};

module.exports = MasterManager;
