var cluster = require("cluster");
var path = require("path")

function MasterManager() {
  if (!(this instanceof MasterManager))
    return new MasterManager();

  this.pools = {};

  this.options = {
    silent: false
  };
}

MasterManager.prototype.isMaster = true;

function Pool(manager, name, options) {
  this.manager = manager;
  this.name = name;
  this.size = options.size || 0;
  this.args = options.args || {};
  this.env = options.env || {};
  this.strict = options.strict;

  this.workers = [];

  this.heartbeatTimeout = options.heartbeatTimeout || 10000;

  this.ttl = options.ttl || 0;
  this.ttlVariance = typeof options.ttlVariance ===  'undefined' ? 0.25 : options.ttlVariance;

  this.killDelay = typeof options.killDelay ===  'undefined' ? 30000 : options.killDelay;

  this.args["USTA_POOL"] = this.env["USTA_POOL"] = this.name;

  for (var i = this.size - 1; i >= 0; i--) {
    this.spawn();
  };
}

Pool.prototype.spawn = function() {
  var self = this;

  var worker = cluster.fork(self.env);

  self.manager.log("Worker " + worker.id + ": spawned.");

  worker.usta = {
    create: new Date(),
    hearbeat: new Date(),
    pool: self.name
  }

  worker.once("online", function () {
    self.manager.log("Worker " + worker.id + ": online.");
  });

  worker.on("message", function (message) {
    worker.usta.hearbeat = new Date();

    if (message.usta_command === 'online') {
      worker.usta.online = true;

      worker.send({
        usta_command: "args",
        payload: self.args
      });
    }
  });

  worker.on("disconnect", function () {
    self.manager.log("Worker " + worker.id + ": disconnected.");

    worker.usta.disconnecttimer = setTimeout(function () {
      self.manager.log("Worker " + worker.id + ": force shutdown.");
      worker.process.kill("SIGKILL")
    }, 5000);
  });

  worker.on("exit", function () {
    self.manager.log("Worker " + worker.id + ": exited.");

    worker.usta.exited = true;

    clearInterval(worker.usta.pingtimer);
    clearTimeout(worker.usta.killtimer);
    clearTimeout(worker.usta.disconnecttimer);

    for (var i = self.workers.length - 1; i >= 0; i--) {
      if (self.workers[i].id == worker.id) {
        self.workers.splice(i, 1);
        break;
      }
    };

    if (!worker.usta.replaced)
      self.spawn();
  });

  if (self.heartbeatTimeout) {
    worker.usta.pingtimer = setInterval(function() {
      function clear() {
        clearInterval(worker.usta.pingtimer);
      }

      if (!worker.process.connected)
        return clear();

      if (worker.usta.hearbeat.getTime() < Date.now() - self.heartbeatTimeout) {
        self.manager.log("Worker " + worker.id + ": exiting due to heartbeat timeout.");
        worker.process.kill("SIGKILL")
        return clear();
      }

      worker.send({ usta_command: 'ping' });
    }, Math.floor(self.heartbeatTimeout / 4));
  }

  if (self.ttl) {
    setTimeout(function () {
      if (worker.usta.exited)
        return;

      self.manager.log("Worker " + worker.id + ": exiting due to ttl.");

      function disconnect() {
        if (worker.process.connected) {
          worker.send({
            usta_command: "disconnect"
          });

          worker.disconnect();
        }

        worker.usta.killtimer = setTimeout(function () {
          self.manager.log("Worker " + worker.id + ": force shutdown.");
          worker.process.kill("SIGKILL")
        }, self.killDelay)
      }

      if (self.strict)
        return disconnect();

      var replacement = self.spawn();

      replacement.once("online", function() {
        worker.usta.replaced = true;
        disconnect();
      });
    }, self.ttl + (self.ttl * self.ttlVariance * Math.random()))
  }

  self.workers.push(worker);

  console.log("Total Workers: " + self.workers.length);

  return worker;
};

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
  if (this.pools[name])
    return this.pools[name];

  this.pools[name] = new Pool(this, name, options);

  return this;
};

MasterManager.prototype.log = function(log) {
  console.log(log);
};

module.exports = MasterManager;
