## Steps to run the metrics dashboard

1. Since we have our metrics and vespa in two separate files communicating with each other, we need to create an external network connection for them to communicate. For this we run the command : 
    ```
    docker network create xyne
    ```
2. Execute the docker-compose in the deployment folder
3. Execute the docker-compose for the metrics dashboard. First navigate to the observability folder, then use the command 
    ```
    docker-compose -f metrics/docker-compose.metrics.yml up
    ```
    This is set up your metrics dashboard using Prometheus and Grafana

### Ensure Prometheus is up and running
 To ensure **Prometheus** is up and running 
   - Navigate to `http://localhost:9090/`.
   - If Prometheus is running correctly you'll land in the dashboard.
   - Then Navigate to Status > Targets.
   - This will take to the lost of targets from which metrics is getting scraped. In our case you should see `xyne-data-ingest` table having an `up` state. 
   - This confirms that prometheus is able to scrape vespa's data correctly.


### Set-up Grafana metrics

To set up **Grafana** dashboad :
- Navigate to `http://localhost:3002/` in your browser.
- To log in use the default username and password (admin)
- Once you see the dashboard, Navigate to Connections using the Nav bar to the left.
- Under Connections you will find a tab for `Data Sources`. Navigate to that and look for `Prometheus`.
- In the `Settings` section of the Prometheus Data Source,  paste the connection URL `http://xyne-prometheus:9090`. This is URL for the prometheus instance running in docker.
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

