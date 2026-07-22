{{/*
Expand the name of the chart.
*/}}
{{- define "xyne.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "xyne.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "xyne.labels" -}}
helm.sh/chart: {{ include "xyne.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels for app
*/}}
{{- define "xyne.app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xyne.fullname" . }}-app
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for dashboard
*/}}
{{- define "xyne.dashboard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xyne.fullname" . }}-dashboard
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for postgresql
*/}}
{{- define "xyne.postgresql.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xyne.fullname" . }}-postgresql
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for vespa
*/}}
{{- define "xyne.vespa.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xyne.fullname" . }}-vespa
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Construct DATABASE_URL
- When postgresql.enabled=true: use CNPG's auto-created <cluster>-rw service
- When postgresql.enabled=false: use externalDatabase values (e.g. RDS, Cloud SQL)
*/}}
{{- define "xyne.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
postgresql://{{ .Values.postgresql.user }}:{{ .Values.postgresql.password }}@{{ include "xyne.fullname" . }}-postgresql-rw:{{ .Values.postgresql.port }}/{{ .Values.postgresql.database }}
{{- else -}}
postgresql://{{ .Values.externalDatabase.user }}:{{ .Values.externalDatabase.password }}@{{ .Values.externalDatabase.host }}:{{ .Values.externalDatabase.port }}/{{ .Values.externalDatabase.database }}
{{- end -}}
{{- end }}

{{/*
Resolve DATABASE_HOST
*/}}
{{- define "xyne.databaseHost" -}}
{{- if .Values.postgresql.enabled -}}
{{ include "xyne.fullname" . }}-postgresql-rw
{{- else -}}
{{ .Values.externalDatabase.host }}
{{- end -}}
{{- end }}
