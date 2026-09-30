variable "project_id" {
  type        = string
  description = "New, dedicated project ID. Never use an existing application's project."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a valid GCP project ID."
  }
}

variable "organization_id" {
  type        = string
  description = "Organization in which the provisioning identity can create the project."
  validation {
    condition     = can(regex("^[0-9]+$", var.organization_id))
    error_message = "organization_id must contain digits only."
  }
}

variable "billing_account_id" {
  type        = string
  description = "Existing billing account to which the provisioning identity can attach projects."
  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "Use a valid billing account ID."
  }
}

variable "app_origin" {
  type        = string
  description = "Exact public HTTPS origin, without a trailing slash."
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.app_origin))
    error_message = "app_origin must be an HTTPS hostname with no path, credentials, port or query."
  }
}

variable "region" {
  type        = string
  description = "Firestore and attachment bucket region; changing it requires data migration."
  default     = "europe-central2"
}

variable "bootstrap_service_account_email" {
  type        = string
  description = "Existing Home Dev bootstrap identity allowed to read only this app's configuration package."
  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.bootstrap_service_account_email))
    error_message = "Use an existing service-account email."
  }
}
