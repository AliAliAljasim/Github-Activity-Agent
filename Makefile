PIDFILE := .server.pid
LOGFILE := .server.log
PORT    := $(shell sed -n 's/^PORT=//p' .env 2>/dev/null | head -1)
PORT    := $(or $(PORT),8000)

.PHONY: start stop restart status

start:
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "Already running (pid $$(cat $(PIDFILE))) at http://localhost:$(PORT)"; \
	else \
		nohup node server.mjs > $(LOGFILE) 2>&1 & echo $$! > $(PIDFILE); \
		sleep 1; \
		if kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
			echo "Started at http://localhost:$(PORT)"; \
		else \
			echo "Failed to start:"; cat $(LOGFILE); rm -f $(PIDFILE); exit 1; \
		fi; \
	fi

stop:
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		kill $$(cat $(PIDFILE)) && echo "Stopped"; \
	else \
		echo "Not running"; \
	fi; rm -f $(PIDFILE)

restart: stop start

status:
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "Running (pid $$(cat $(PIDFILE))) at http://localhost:$(PORT)"; \
	else echo "Not running"; fi
