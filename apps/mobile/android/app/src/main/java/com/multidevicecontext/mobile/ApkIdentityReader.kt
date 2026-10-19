package com.multidevicecontext.mobile

import java.io.File

internal data class ApkPackageMetadata(
 val packageName:String,
 val versionName:String,
 val versionCode:Long,
 val minimumSdk:Int,
 val targetSdk:Int,
) {
 fun validate() {
  // Android permits an omitted version name/code; the catalog policy still
  // requires the offered version and an increasing positive code for updates.
  if(packageName.isBlank() || versionCode<0 || minimumSdk<=0 || targetSdk<=0)
   throw ApkMetadataException()
 }
 fun identity(signers:Set<String>)=ApkIdentity(packageName,versionName,versionCode,minimumSdk,signers)
}

// A null signer set means the modern query omitted SigningInfo. An empty or
// malformed signer set is an explicit failure and must never enable fallback.
internal data class ApkPackageSnapshot(val metadata:ApkPackageMetadata,val signerDigests:Set<String>?)

internal interface ApkPackageSource {
 val usesModernSigning:Boolean
 fun archive(file:File,legacySignatures:Boolean):ApkPackageSnapshot?
 fun installed():ApkPackageSnapshot
}

internal class ApkMetadataException:IllegalArgumentException("APK metadata unavailable or inconsistent")
internal class ApkSigningMetadataException:IllegalArgumentException("APK signing metadata unavailable")

internal class ApkIdentityReader(private val packages:ApkPackageSource) {
 fun inspectArchive(file:File):ApkIdentity {
  val canonical=file.canonicalFile
  val primary=packages.archive(canonical,false) ?: throw ApkMetadataException()
  primary.metadata.validate()
  if(primary.signerDigests!=null || !packages.usesModernSigning)return identity(primary)

  // Some OEM frameworks parse archives but omit SigningInfo. Requery only that
  // case, using the same canonical file and the installed modern current signers.
  val installed=installed()
  val legacy=packages.archive(canonical,true) ?: throw ApkMetadataException()
  legacy.metadata.validate()
  if(legacy.metadata!=primary.metadata)throw ApkMetadataException()
  val candidate=identity(legacy)
  require(candidate.signerDigests==installed.signerDigests) {"Update signing certificate does not match"}
  return candidate
 }

 fun installed():ApkIdentity {
  val snapshot=packages.installed()
  if(snapshot.metadata.packageName!=ApkInspector.PACKAGE_NAME)throw ApkMetadataException()
  return identity(snapshot)
 }

 private fun identity(snapshot:ApkPackageSnapshot):ApkIdentity {
  snapshot.metadata.validate()
  val signers=snapshot.signerDigests
  if(signers.isNullOrEmpty() || signers.any {!SIGNER_DIGEST.matches(it)})throw ApkSigningMetadataException()
  return snapshot.metadata.identity(signers)
 }

 companion object {private val SIGNER_DIGEST=Regex("^[a-f0-9]{64}$")}
}

internal object UpdateFailureReason {
 fun safe(cause:Exception):String=when {
  cause is ApkSigningMetadataException -> "Android could not read the package signing information. The update was not installed."
  cause is ApkMetadataException -> "The package metadata could not be verified."
  cause.message?.contains("certificate",true)==true -> "The signing certificate did not match."
  cause.message?.contains("version",true)==true -> "The package version was invalid."
  cause.message?.contains("size",true)==true || cause.message?.contains("incomplete",true)==true -> "The downloaded size did not match."
  cause.message?.contains("SHA-",true)==true -> "The downloaded digest did not match."
  else -> "Check your connection and try again."
 }
}
