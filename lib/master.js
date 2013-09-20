var cluster = require("cluster");
var path = require("path")

function MasterManager(options) {
  if (!(this instanceof MasterManager))
    return new MasterManager(options);

  this.pools = {};

  this.options = {
    silent: false
  };

  if (options)
    this.config(options);

  cluster.setupMaster({
    silent: this.options.silent,
    exec: this.options.exec,
    args: this.options.args || []
  });
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
    pool: self.name
  }

  worker.once("online", function () {
    self.manager.log("Worker " + worker.id + ": online.");
  });

  worker.on("message", function (message) {
    if (message.usta_command === 'online') {
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

  if (self.ttl) {
    setTimeout(function () {
      if (worker.usta.exited)
        return;

      self.manager.log("Worker " + worker.id + ": exiting due to ttl.");

      function disconnect() {
        worker.send({
          usta_command: "disconnect"
        });

        worker.disconnect();

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

module.exports = MasterManager;

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

  return this.pools[name] = new Pool(this, name, options);
};

MasterManager.prototype.log = function(log) {
  console.log(log);
};
