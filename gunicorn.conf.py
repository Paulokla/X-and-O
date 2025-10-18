# gunicorn.conf.py
import multiprocessing
import os

# Bind to the correct port for Render - use environment variable
port = os.environ.get('PORT', '10000')
bind = f"0.0.0.0:{port}"

# Worker configuration - optimized for WebSockets
workers = 1
worker_class = "gevent"
worker_connections = 1000
timeout = 120
keepalive = 2
max_requests = 1000
max_requests_jitter = 100

# Logging
accesslog = "-"
errorlog = "-"
loglevel = "debug"  # Changed to debug for more info

# Process naming
proc_name = "x_and_o_app"

# Handle graceful shutdown
graceful_timeout = 30

# Add these for better stability
preload_app = True
reuse_port = True