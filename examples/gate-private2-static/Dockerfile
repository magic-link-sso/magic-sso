FROM caddy:2-alpine
COPY examples/gate-private2-static/Caddyfile /etc/caddy/Caddyfile
COPY examples/gate-private2-static/public /srv
EXPOSE 3008
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
