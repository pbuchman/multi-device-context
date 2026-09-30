output "runtime_connection" {
  description = "Public app identifiers; never include provisioning client secrets."
  sensitive   = true
  value = {
    MDC_AUTH0_AUDIENCE         = auth0_resource_server.api.identifier
    MDC_AUTH0_WEB_CLIENT_ID    = auth0_client.app["web"].id
    MDC_AUTH0_NATIVE_CLIENT_ID = auth0_client.app["native"].id
  }
}

