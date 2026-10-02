terraform {
  required_version = ">= 1.5.7"
  required_providers {
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "8.5.0"
    }
  }
  backend "local" {}
}

provider "google-beta" {
  project               = var.project_id
  billing_project       = var.project_id
  region                = var.region
  user_project_override = true
}

# Project creation and initial API activation cannot charge quota to a project
# that does not exist yet.
provider "google-beta" {
  alias                 = "bootstrap"
  user_project_override = false
}

resource "google_project" "app" {
  provider        = google-beta.bootstrap
  project_id      = var.project_id
  name            = "Multi Device Context"
  org_id          = var.organization_id
  billing_account = var.billing_account_id
  deletion_policy = "PREVENT"
  labels          = { application = "multi-device-context", firebase = "enabled" }
}

resource "google_project_service" "api" {
  provider = google-beta.bootstrap
  for_each = toset([
    "serviceusage.googleapis.com", "cloudresourcemanager.googleapis.com", "cloudbilling.googleapis.com",
    "apikeys.googleapis.com", "firebase.googleapis.com", "firebaserules.googleapis.com",
    "firebasestorage.googleapis.com", "firestore.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "identitytoolkit.googleapis.com",
    "secretmanager.googleapis.com", "storage.googleapis.com",
  ])
  project            = google_project.app.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firebase_project" "app" {
  provider   = google-beta
  project    = google_project.app.project_id
  depends_on = [google_project_service.api]
  lifecycle { prevent_destroy = true }
}

resource "google_firestore_database" "app" {
  provider                = google-beta
  project                 = google_project.app.project_id
  name                    = "(default)"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  depends_on              = [google_firebase_project.app]
  lifecycle { prevent_destroy = true }
}

resource "google_identity_platform_config" "app" {
  provider           = google-beta
  project            = google_project.app.project_id
  authorized_domains = [trimprefix(var.app_origin, "https://"), "localhost"]
  sign_in {
    allow_duplicate_emails = false
    anonymous { enabled = false }
    email {
      enabled           = false
      password_required = true
    }
    phone_number { enabled = false }
  }
  depends_on = [google_firebase_project.app]
}

resource "google_apikeys_key" "browser" {
  provider     = google-beta
  project      = google_project.app.project_id
  name         = "mdc-browser"
  display_name = "Multi Device Context browser"
  restrictions {
    browser_key_restrictions { allowed_referrers = ["${var.app_origin}/*", "https://localhost/*"] }
    api_targets { service = "identitytoolkit.googleapis.com" }
    api_targets { service = "securetoken.googleapis.com" }
    api_targets { service = "firestore.googleapis.com" }
    api_targets { service = "firebasestorage.googleapis.com" }
  }
  depends_on = [google_identity_platform_config.app]
}

resource "google_firebase_web_app" "app" {
  provider     = google-beta
  project      = google_project.app.project_id
  display_name = "Multi Device Context"
  api_key_id   = google_apikeys_key.browser.uid
  depends_on   = [google_identity_platform_config.app]
}

data "google_firebase_web_app_config" "app" {
  provider   = google-beta
  project    = google_project.app.project_id
  web_app_id = google_firebase_web_app.app.app_id
}

resource "google_storage_bucket" "attachments" {
  provider                    = google-beta
  project                     = google_project.app.project_id
  name                        = "${var.project_id}-attachments"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  # User deletion removes live bytes; no automatic retention of deleted objects.
  soft_delete_policy { retention_duration_seconds = 0 }
  cors {
    origin          = [var.app_origin, "https://localhost"]
    method          = ["GET", "HEAD", "POST", "PUT"]
    response_header = ["Content-Type", "Content-Length", "Content-Range", "ETag"]
    max_age_seconds = 3600
  }
  depends_on = [google_firebase_project.app]
  lifecycle { prevent_destroy = true }
}

resource "google_firebase_storage_bucket" "attachments" {
  provider        = google-beta
  project         = google_project.app.project_id
  bucket_id       = google_storage_bucket.attachments.name
  deletion_policy = "PREVENT"
}

# Storage rules verify context/item ownership against the default Firestore DB.
# This narrowly scoped service-agent role grants datastore.entities.get only.
resource "google_project_service_identity" "firebase_storage" {
  provider   = google-beta
  project    = google_project.app.project_id
  service    = "firebasestorage.googleapis.com"
  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "storage_rules_firestore" {
  provider = google-beta
  project  = google_project.app.project_id
  role     = "roles/firebaserules.firestoreServiceAgent"
  member   = "serviceAccount:${google_project_service_identity.firebase_storage.email}"
}

resource "google_service_account" "runtime" {
  provider     = google-beta
  project      = google_project.app.project_id
  account_id   = "mdc-home-runtime"
  display_name = "Multi Device Context Home Dev runtime"
  depends_on   = [google_project_service.api]
}

resource "google_project_iam_member" "runtime_firestore" {
  provider = google-beta
  project  = google_project.app.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "runtime_objects" {
  provider = google-beta
  bucket   = google_storage_bucket.attachments.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

# Health checks need bucket metadata, but the runtime cannot change bucket IAM.
resource "google_project_iam_custom_role" "bucket_reader" {
  provider    = google-beta
  project     = google_project.app.project_id
  role_id     = "mdcBucketMetadataReader"
  title       = "MDC bucket metadata reader"
  permissions = ["storage.buckets.get"]
}

resource "google_storage_bucket_iam_member" "runtime_metadata" {
  provider = google-beta
  bucket   = google_storage_bucket.attachments.name
  role     = google_project_iam_custom_role.bucket_reader.name
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_service_account_iam_member" "runtime_signer" {
  provider           = google-beta
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret" "runtime_config" {
  provider  = google-beta
  project   = google_project.app.project_id
  secret_id = "mdc-runtime-config"
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
  lifecycle { prevent_destroy = true }
}

resource "google_secret_manager_secret_iam_member" "bootstrap_reader" {
  provider  = google-beta
  project   = google_project.app.project_id
  secret_id = google_secret_manager_secret.runtime_config.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.bootstrap_service_account_email}"
}

# No private key or secret payload is created in Terraform state. Bootstrap those
# through the documented private provisioning process after resource validation.
