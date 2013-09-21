# usta
Worker process coordinator for Node.JS clusters. It used the built in `cluster` module to fire up multiple node processes and coordinates the work between them.

##install

	npm install usta

##usage
usta has 2 different interfaces, one for the master process and one for the worker processes. The basic idea is to have multiple pools of processes. One can define a pool for web server that contains 4 child processes, a single process for background jobs and 2 more for work queue consumers easily.

###master

	var usta = require('usta');

	if (usta.isMaster) {
		// Necessary
		// Setup the cluster master
		usta.setup({
			silent: false, // Suppress child process output, default false
			exec: __filename, // The entry point for workers, if not specified, current file is used
			logger: function(log) {…} // A function to intercept logs. Defaults to stdout.
		});

		// Create a new worker pool
		// poolname is required, all config vars are optional, default values are listed below.
		// usta.pool(poolname, options)
		usta.pool('web', {
			ttl: 0, // Time in ms to recycle processes. Children will be restarted in this period.
			size: 0, // Number of child processes required for this pool
			args: {}, // Custom arguments to be sent to children
			env: {}, // Custom environment variables
			strict: false, // If true, pool does not have more than size processes in any case
			killDelay: 60000, // Wait time in ms to forcefully kill a process that does not gracefully exit
			restartDelay: 2000 // Wait time in ms for consecutive restarts
		});

		// Create another pool
		usta.pool('crons', {
			…
		});
	}

## worker

	var usta = require('usta');

	if (!usta.isMaster) {
		// All workers are created equal, therefore it is required to distinguish pools here.
		// Register a function to be called for web workers
		usta.register("web", function() {
			// do whatever you wish
		});

		// Register another type of worker
		usta.register("crons", function() {
			// do whatever you wish
		});
	}

##license
MIT
