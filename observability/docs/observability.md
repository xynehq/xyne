## Steps to run the metrics dashboard

To run the metrics, from the root folder run this command in the terminal
```sh
docker-compose -f deployment/docker-compose.metrics.yml up
```

### Ensure Prometheus is up and running
 To ensure **Prometheus** is up and running
   - Navigate to `http://localhost:9090/`.
   - If Prometheus is running correctly you'll land in the dashboard.
   - Then Navigate to Status > Targets.
   - This will take to the list of targets from which metrics is getting scraped. In our case you should see `xyne-data-ingest` table having an `up` state.
   - This confirms that prometheus is able to scrape vespa's data correctly.


### Set-up Grafana metrics

To set up **Grafana** dashboad :
- Navigate to `http://localhost:3002/` in your browser.
- To log in use the default username and password (admin)
- Once you see the dashboard, Navigate to Connections using the Nav bar to the left.
- Under Connections you will find a tab for `Data Sources`. Navigate to that and look for `Prometheus`.
- In the `Settings` section of the Prometheus Data Source,  paste the connection URL `http://xyne-prometheus:9090`. This is URL for the prometheus instance running in docker. Also ensure that the `name` property is set to `prometheusSource`, if it isn't already present.
- Now scroll down to Save and Test your connection. It should show a `Successful` message.
- Now using the same Nav bar to the left, navigate to `Dashboards`.
- Once on the dashboard page you will see the `New` button in the top right corner. Click on that button and select the `import` option.
- Now in the import section, either upload or paste the `grafana-metrics.json` file in the setup folder of this directory.
- Click on load and then import.
- You should now have the dashboard imported successfully. Navigate back to the Dashboard section and you should see the `Xyne Metrics` dashboard up.
- Initially you will have to:
    - Click on the dashboard.
    - Hover on the panel and click on the menu (the three dots to the top-right of the panel), and click edit.
    - In the `Queries` tab select the **prometheus** datasource which you've just added.
    - Click on `Run Queries` to get the results.
    - Follow the same steps for the rest of the panels.

### Monitoring PM2 Instances with pm2-prom-module

To monitor your PM2 instances and view metrics in Grafana, you can use the `pm2-prom-module`.

**1. Install pm2-prom-module:**

Open your terminal and run the following PM2 command to install the module:

```sh
pm2 install pm2-prom-module
```

This module will automatically start an HTTP server on port `9988` to export Prometheus-compatible metrics.
*Note: If you need to change the default port (e.g., to `10801`), you can do so using the command: `pm2 set pm2-prom-module:port 10801`. Remember to update the Prometheus configuration accordingly if you change this port.*

**2. Configure Prometheus to Scrape PM2 Metrics:**

For Prometheus to collect these metrics, you need to update its configuration.
Open the `deployment/prometheus-selfhosted.yml` file.
Locate the following commented-out section:

```yaml
  # - job_name: 'pm2'
  #   metrics_path: /
  #   scrape_interval: 2s
  #   static_configs:
  #     - targets: ['host.docker.internal:9988']
```

Uncomment this entire block by removing the `#` at the beginning of each line:

```yaml
  - job_name: 'pm2'
    metrics_path: /
    scrape_interval: 2s
    static_configs:
      - targets: ['host.docker.internal:9988'] # Ensure this port matches the one pm2-prom-module is using (default is 9988)
```

**3. Restart Prometheus (if necessary):**

If your Prometheus instance is running via Docker Compose (e.g., using `deployment/docker-compose.metrics.yml` or `deployment/docker-compose.selfhost.yml`), you might need to restart it for the changes to take effect:

```sh
# If using docker-compose.metrics.yml
docker-compose -f deployment/docker-compose.metrics.yml restart prometheus

# Or if using docker-compose.selfhost.yml
docker-compose -f deployment/docker-compose.selfhost.yml restart prometheus
```
*(Adjust the command based on how Prometheus is being run in your environment).*

**4. View Metrics in Grafana:**

Once Prometheus starts scraping the PM2 metrics, they will be available in your Grafana instance. The "Xyne PM2 Metrics" dashboard, which is provisioned from `deployment/grafana/provisioning/dashboards/xyne_pm2_metrics.json`, should display these metrics. If Prometheus is correctly scraping, you should also see a `pm2` target with an `UP` state in Prometheus under `Status > Targets` (usually at `http://localhost:9090/targets`).

**5. Security Considerations:**

When exposing metrics via `pm2-prom-module` and configuring Prometheus to scrape them, it's important to consider the security implications, especially in production environments:

*   **Data Exposure:** The metrics endpoint (e.g., `http://host.docker.internal:9988`) can expose operational data about your PM2 processes. Ensure this data does not contain overly sensitive information.
*   **Network Access:**
    *   Restrict access to the metrics port (`9988` or your custom port) to only authorized networks or hosts. This can typically be achieved using firewall rules (e.g., `ufw`, `iptables`), cloud provider security groups, or by ensuring the PM2 host is not directly accessible from the public internet.
    *   Ideally, the Prometheus server and the PM2 host should communicate over a private network.
*   **Authentication (Advanced):** While `pm2-prom-module` itself may not offer robust built-in authentication for its metrics endpoint, you can place a reverse proxy (like Nginx or Apache) in front of the PM2 host that exposes the metrics. This reverse proxy can then be configured to require authentication (e.g., Basic Auth) before allowing access to the metrics endpoint. Prometheus can then be configured to use these credentials.
*   **Regular Review:** Periodically review your monitoring setup to ensure it aligns with your organization's security policies.