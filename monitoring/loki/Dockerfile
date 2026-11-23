FROM grafana/loki:3.7.10
COPY loki.yaml /etc/loki/loki.yaml
CMD ["-config.file=/etc/loki/loki.yaml", "-config.expand-env=true"]
