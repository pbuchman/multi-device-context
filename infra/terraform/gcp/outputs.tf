output "runtime_connection" {
  description = "Public runtime connection values; project-specific configuration stays private."
  sensitive   = true
  value = {
    MDC_APP_ORIGIN           = var.app_origin
    MDC_GCP_PROJECT_ID       = google_project.app.project_id
    MDC_FIREBASE_API_KEY     = data.google_firebase_web_app_config.app.api_key
    MDC_FIREBASE_AUTH_DOMAIN = data.google_firebase_web_app_config.app.auth_domain
    MDC_STORAGE_BUCKET       = google_storage_bucket.attachments.name
  }
}

output "runtime_service_account" {
  value       = google_service_account.runtime.email
  description = "Dedicated runtime principal; no service-account key is emitted."
}

output "runtime_config_secret" {
  value       = google_secret_manager_secret.runtime_config.id
  description = "Secret package container; create its payload outside Terraform state."
}

