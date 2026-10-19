package com.multidevicecontext.mobile

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ApkIdentityReaderTest {
 private val trusted="a".repeat(64)
 private val other="b".repeat(64)
 private val metadata=ApkPackageMetadata("com.multidevicecontext.mobile","0.6.4",21,26,36)
 private val signed=ApkPackageSnapshot(metadata,setOf(trusted))
 private val apk=File("private-cache/updates/../updates/update.apk")
 private val offer=AndroidUpdateOffer("0.6.4",21,"https://github.com/pbuchman/multi-device-context/releases/download/v0.6.4/update.apk","update.apk",1,"0".repeat(64),"A".repeat(86)+"==",26)

 @Test fun prefersModernCurrentSignersWithoutAnyLegacyOrInstalledQuery() {
  val source=Source()
  assertEquals(setOf(trusted),ApkIdentityReader(source).inspectArchive(apk).signerDigests)
  assertEquals(listOf(apk.canonicalFile to false),source.archiveQueries)
  assertEquals(0,source.installedQueries)
 }

 @Test fun onlyAbsentModernSigningInfoCanUseMatchingLegacyCurrentSigners() {
  val source=Source(primary=signed.copy(signerDigests=null))
  val reader=ApkIdentityReader(source)
  val candidate=reader.inspectArchive(apk)
  ApkIdentityPolicy.validate(candidate,reader.installed(),offer,33)
  assertEquals(setOf(trusted),candidate.signerDigests)
  assertEquals(listOf(apk.canonicalFile to false,apk.canonicalFile to true),source.archiveQueries)
 }

 @Test fun rejectsMissingEmptyMalformedDifferentSubsetAndExtraLegacySigners() {
  val legacyCandidates=listOf(null,signed.copy(signerDigests=null),signed.copy(signerDigests=emptySet()),
   signed.copy(signerDigests=setOf("malformed")),signed.copy(signerDigests=setOf(other)),signed.copy(signerDigests=setOf(trusted,other)))
  for(legacy in legacyCandidates) {
   assertThrows(IllegalArgumentException::class.java) {ApkIdentityReader(Source(primary=signed.copy(signerDigests=null),legacy=legacy)).inspectArchive(apk)}
  }
  assertThrows(IllegalArgumentException::class.java) {
   ApkIdentityReader(Source(primary=signed.copy(signerDigests=null),installed=signed.copy(signerDigests=setOf(trusted,other)))).inspectArchive(apk)
  }
 }

 @Test fun rejectsEveryContradictoryMetadataFieldAcrossArchiveQueries() {
  val changed=listOf(metadata.copy(packageName="other.app"),metadata.copy(versionName="0.6.5"),
   metadata.copy(versionCode=22),metadata.copy(minimumSdk=27),metadata.copy(targetSdk=35))
  for(value in changed) {
   assertThrows(ApkMetadataException::class.java) {
    ApkIdentityReader(Source(primary=signed.copy(signerDigests=null),legacy=signed.copy(metadata=value))).inspectArchive(apk)
   }
  }
 }

 @Test fun rejectsInvalidPrimaryMetadataAndExplicitModernSignerFailuresWithoutFallback() {
  val invalid=listOf(null,signed.copy(metadata=metadata.copy(packageName="")),
   signed.copy(metadata=metadata.copy(versionCode=-1)),signed.copy(metadata=metadata.copy(minimumSdk=0)),signed.copy(metadata=metadata.copy(targetSdk=0)),
   signed.copy(signerDigests=emptySet()),signed.copy(signerDigests=setOf("malformed")))
  for(primary in invalid) {
   val source=Source(primary=primary)
   assertThrows(IllegalArgumentException::class.java) {ApkIdentityReader(source).inspectArchive(apk)}
   assertEquals(1,source.archiveQueries.size)
   assertEquals(0,source.installedQueries)
  }
 }

 @Test fun aModernMismatchCannotBeOverriddenByAMatchingLegacyCertificate() {
  val source=Source(primary=signed.copy(signerDigests=setOf(other)))
  val reader=ApkIdentityReader(source)
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(reader.inspectArchive(apk),reader.installed(),offer,33)}
  assertEquals(1,source.archiveQueries.size)
 }

 @Test fun installedSigningMetadataFailureNeverEnablesInstalledOrArchiveFallback() {
  for(installed in listOf(signed.copy(signerDigests=null),signed.copy(signerDigests=emptySet()),signed.copy(signerDigests=setOf("malformed")),signed.copy(metadata=metadata.copy(packageName="other.app")))) {
   val source=Source(primary=signed.copy(signerDigests=null),installed=installed)
   assertThrows(IllegalArgumentException::class.java) {ApkIdentityReader(source).inspectArchive(apk)}
   assertEquals(1,source.archiveQueries.size)
   assertEquals(1,source.installedQueries)
  }
 }

 @Test fun unexpectedArchiveAndInstalledQueryFailuresDoNotEnableFallback() {
  val archiveFailure=Source().apply {archiveFailure=SecurityException("synthetic query failure")}
  assertThrows(SecurityException::class.java) {ApkIdentityReader(archiveFailure).inspectArchive(apk)}
  assertEquals(1,archiveFailure.archiveQueries.size)
  val installedFailure=Source(primary=signed.copy(signerDigests=null)).apply {installedFailure=SecurityException("synthetic installed failure")}
  assertThrows(SecurityException::class.java) {ApkIdentityReader(installedFailure).inspectArchive(apk)}
  assertEquals(1,installedFailure.archiveQueries.size)
 }

 @Test fun fallbackStillEnforcesIncreasingVersionPackageCatalogSdkAndExactSignerSet() {
  val reader=ApkIdentityReader(Source(primary=signed.copy(signerDigests=null)))
  val candidate=reader.inspectArchive(apk);val installed=reader.installed()
  ApkIdentityPolicy.validate(candidate,installed,offer,33)
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate,installed.copy(versionCode=21),offer,33)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate.copy(packageName="other.app"),installed,offer,33)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate,installed,offer.copy(versionCode=22),33)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate.copy(versionName=""),installed,offer,33)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate.copy(versionCode=0),installed,offer,33)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate.copy(minimumSdk=34),installed,offer,33)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(candidate,installed.copy(signerDigests=emptySet()),offer,33)}
 }

 @Test fun oldAndroidUsesItsPrimaryLegacyResultWithoutAnOemRequery() {
  val source=Source().apply {usesModernSigning=false}
  assertEquals(setOf(trusted),ApkIdentityReader(source).inspectArchive(apk).signerDigests)
  assertEquals(1,source.archiveQueries.size)
  val missing=Source(primary=signed.copy(signerDigests=null)).apply {usesModernSigning=false}
  assertThrows(ApkSigningMetadataException::class.java) {ApkIdentityReader(missing).inspectArchive(apk)}
  assertEquals(1,missing.archiveQueries.size)
 }

 @Test fun signingMetadataErrorsHaveAFixedVerificationMessageWithoutPrivateDetails() {
  assertEquals("Android could not read the package signing information. The update was not installed.",UpdateFailureReason.safe(ApkSigningMetadataException()))
  assertEquals("The package metadata could not be verified.",UpdateFailureReason.safe(ApkMetadataException()))
  assertEquals("The signing certificate did not match.",UpdateFailureReason.safe(IllegalArgumentException("Update signing certificate does not match")))
  assertEquals("Check your connection and try again.",UpdateFailureReason.safe(java.io.IOException("private URL and details")))
 }

 private inner class Source(
  private val primary:ApkPackageSnapshot?=signed,
  private val legacy:ApkPackageSnapshot?=signed,
  private val installed:ApkPackageSnapshot=signed.copy(metadata=metadata.copy(versionName="0.6.3",versionCode=20)),
 ):ApkPackageSource {
  override var usesModernSigning=true
  val archiveQueries=mutableListOf<Pair<File,Boolean>>()
  var installedQueries=0
  var archiveFailure:RuntimeException?=null
  var installedFailure:RuntimeException?=null
  override fun archive(file:File,legacySignatures:Boolean):ApkPackageSnapshot? {
   archiveQueries.add(file to legacySignatures)
   archiveFailure?.let {throw it}
   return if(legacySignatures)legacy else primary
  }
  override fun installed():ApkPackageSnapshot {
   installedQueries++
   installedFailure?.let {throw it}
   return installed
  }
 }
}
