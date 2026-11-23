FROM prom/prometheus:v3.13.5
COPY prometheus.yml /etc/prometheus/prometheus.yml
COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
