# Production deployment

The production service intentionally runs one Python worker. Browser-session
state and the per-session Java solver registry are in-process, so multiple
workers would route requests to inconsistent registries.

Expected layout:

```text
/opt/dashviz/current  application checkout
/opt/dashviz/venv     Python virtual environment
/etc/dashviz.env      production settings
```

Install the service after the frontend and Java artifacts have been built and
the backend dependencies have been installed:

```bash
cd /opt/dashviz/current/sessionserver
./gradlew sessionServerJar
cd /opt/dashviz/current/frontend
pnpm install --frozen-lockfile
pnpm build
python3 -m venv /opt/dashviz/venv
/opt/dashviz/venv/bin/python -m pip install /opt/dashviz/current/backend
```

Copy `dashviz.env.example` to `/etc/dashviz.env`, install `dashviz.service` in
`/etc/systemd/system`, and enable it. The nginx template expects a Let's Encrypt
certificate for `dashviz.cs.uwaterloo.ca`; obtain that certificate before
enabling the TLS server block.
