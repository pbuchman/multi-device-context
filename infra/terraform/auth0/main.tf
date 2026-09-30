terraform {
  required_version = ">= 1.5.7"
  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "1.58.0"
    }
  }
  backend "local" {}
}

# Management credentials come only from AUTH0_DOMAIN and AUTH0_API_TOKEN
# (or AUTH0_CLIENT_ID/AUTH0_CLIENT_SECRET) in the private provisioning environment.
provider "auth0" {}

data "auth0_connection" "google" {
  name                 = "google-oauth2"
  hide_client_secret   = true
  skip_enabled_clients = true
}

resource "auth0_resource_server" "api" {
  name                                            = "Multi Device Context API"
  identifier                                      = "${var.app_origin}/api"
  signing_alg                                     = "RS256"
  token_dialect                                   = "access_token"
  token_lifetime                                  = 3600
  allow_offline_access                            = true
  skip_consent_for_verifiable_first_party_clients = true
  lifecycle { prevent_destroy = true }
}

locals {
  clients = {
    web = {
      name      = "Multi Device Context Web"
      type      = "spa"
      callbacks = ["${var.app_origin}/auth/callback"]
    }
    native = {
      name      = "Multi Device Context Desktop"
      type      = "native"
      callbacks = ["multi-device-context://auth/callback"]
    }
  }
}

resource "auth0_client" "app" {
  for_each            = local.clients
  name                = each.value.name
  app_type            = each.value.type
  is_first_party      = true
  oidc_conformant     = true
  grant_types         = ["authorization_code", "refresh_token"]
  callbacks           = each.value.callbacks
  allowed_logout_urls = [var.app_origin]
  web_origins         = each.key == "web" ? [var.app_origin] : []
  allowed_origins     = each.key == "web" ? [var.app_origin] : []
  jwt_configuration { alg = "RS256" }
  refresh_token {
    rotation_type                = "rotating"
    expiration_type              = "expiring"
    token_lifetime               = 2592000
    idle_token_lifetime          = 604800
    infinite_token_lifetime      = false
    infinite_idle_token_lifetime = false
    leeway                       = 10
  }
  lifecycle { prevent_destroy = true }
}

resource "auth0_client_credentials" "public" {
  for_each              = auth0_client.app
  client_id             = each.value.id
  authentication_method = "none"
}

# Manage only the new app's links. Do not take ownership of all clients on the
# shared Google connection, which would risk disabling unrelated applications.
resource "auth0_connection_client" "google" {
  for_each      = auth0_client.app
  connection_id = data.auth0_connection.google.id
  client_id     = each.value.id
  lifecycle {
    precondition {
      condition     = data.auth0_connection.google.strategy == "google-oauth2"
      error_message = "The existing Google connection must use google-oauth2."
    }
  }
}
