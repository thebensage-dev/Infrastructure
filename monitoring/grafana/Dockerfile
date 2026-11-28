FROM grafana/grafana:13.3.2
COPY provisioning /etc/grafana/provisioning
COPY dashboards /etc/grafana/dashboards
# Makes the "Live status" dashboard public at a fixed link on every start (STATUS_ACCESS_TOKEN),
# alongside Grafana itself.
COPY --chmod=755 share-status.sh /usr/local/bin/share-status.sh
ENTRYPOINT ["/bin/sh", "-c", "/usr/local/bin/share-status.sh & exec /run.sh \"$@\"", "--"]
