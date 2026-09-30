variable "app_origin" {
  type        = string
  description = "Exact public HTTPS application origin, without a trailing slash."
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.app_origin))
    error_message = "app_origin must be an HTTPS hostname with no path, credentials, port or query."
  }
}

