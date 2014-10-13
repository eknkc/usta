var cluster = require("cluster");
var path = require("path");
var util = require("util");
var events = require("events");

function MasterManager() {
  if (!(this instanceof MasterManager))
    return new MasterManager();

  this.pools = {};

  this.options = {
    silent: false,
    logger: function(log) {
      var msg = ["master: " + log.level];

      if (log.worker)
        msg.push("worker " + log.worker);

      if (log.pool)
        msg.push("pool " + log.pool);

      msg.push(log.message);

      console.log(msg.join(" | "));
    }
  };
}

function Pool(manager, name, options) {
  events.EventEmitter.call(this);

  this.manager = manager;
  this.name = name;
  this.size = options.size || 0;
  this.args = options.args || {};
  this.env = options.env || {};
  this.strict = !!options.strict;
  this.total = 0;

  this.workers = [];

  this.heartbeatTimeout = options.heartbeatTimeout || 30000;

  this.ttl = options.ttl || 0;
  this.ttlVariance = typeof options.ttlVariance === 'undefined' ? 0.25 : options.ttlVariance;

  this.killDelay = typeof options.killDelay ===  'undefined' ? 60000 : options.killDelay;
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
    }, 10000);
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
  if (typeof log == 'string') {
    log = {
      message: log,
      level: 'info'
    };
  }

  log.worker = this.worker.id;
  this.pool.log(log);
};

Worker.prototype.send = function(message) {
  if (this.worker.process.connected) {
    this.worker.send(message);
  }
};

Pool.prototype.spawn = function() {
  var self = this;

  var worker = new Worker(this, cluster.fork(self.env));

  self.total++;

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
  if (typeof log == 'string') {
    log = {
      message: log,
      level: 'info'
    };
  }

  log.pool = this.name;
  this.manager.log(log);
};

MasterManager.prototype.isMaster = true;

MasterManager.prototype.register = function() {
  // Noop
};

MasterManager.prototype.setup = function(options) {
  var self = this;

  self.config(options);

  var setupMasterOptions = {
    silent: self.options.silent,
    args: self.options.args || []
  };

  if(self.options.exec)
    setupMasterOptions.exec = self.options.exec;

  cluster.setupMaster(setupMasterOptions);


  function exit() {
    self.kill("DISPOSE");
    process.exit(0);
  }

  try {
    process.on("SIGHUP", function() { self.kill(); })
    process.on("SIGINT", exit)
    process.on("SIGTERM", exit)
    process.on("SIGQUIT", exit)
  } catch (e) {}

  return self;
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

    if (cmd.command == 'status') {
      cmd.worker.send({ usta_command: 'status', status: self.status() });
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

MasterManager.prototype.status = function(first_argument) {
  var data = {
    pid: process.pid,
    workers: cluster.workers.length,
    pools: {}
  };

  Object.keys(this.pools).forEach(function (pname) {
    var pool = this.pools[pname];

    var pdata = data.pools[pname] = {
      count: pool.workers.length,
      size: pool.size,
      total: pool.total,
      ttl: pool.ttl,
      killDelay: pool.killDelay,
      restartDelay: pool.restartDelay,
      workers: []
    };

    pool.workers.forEach(function (worker) {
      pdata.workers.push({
        id: worker.id,
        pid: worker.pid,
        age: Math.floor((Date.now() - worker.create.getTime()) / 1000),
        heartbeat: Math.floor((Date.now() - worker.hearbeat.getTime()) / 1000),
        restarting: !!worker.restarting,
        exited: !!worker.exited
      })
    }, this);
  }, this);

  return data;
};

MasterManager.prototype.log = function(log) {
  if (typeof log == 'string') {
    log = {
      message: log,
      level: 'info'
    };
  }

  if (!log.level)
    log.level = "info";

  this.options.logger(log);
};

module.exports = MasterManager;
