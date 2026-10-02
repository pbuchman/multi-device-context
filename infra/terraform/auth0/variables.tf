variable "app_origin" {
  type        = string
  description = "Exact public HTTPS application origin, without a trailing slash."
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.app_origin))
    error_message = "app_origin must be an HTTPS hostname with no path, credentials, port or query."
  }
}


variable "android_auth0_domain" {
  type        = string
  description = "Existing public Auth0 domain for the private Android callback; null leaves desktop-only provisioning unchanged."
  default     = null
  validation {
    condition     = var.android_auth0_domain == null ? true : can(regex("^[a-zA-Z0-9][a-zA-Z0-9.-]+$", var.android_auth0_domain))
    error_message = "Use the Auth0 hostname without scheme or path."
  }
}
