package com.multidevicecontext.mobile

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection

class NativeInstallation(context:Context) {
 private val origin=context.getString(R.string.mdc_app_origin)
 private val prefs=context.getSharedPreferences("mdc-installation",Context.MODE_PRIVATE)
 private val scope=listOf(origin,context.getString(R.string.com_auth0_domain),context.getString(R.string.com_auth0_client_id),context.getString(R.string.mdc_audience)).joinToString("\n")
 private val alias="mdc-installation-v1"
 private fun key():SecretKey {
  val store=KeyStore.getInstance("AndroidKeyStore").apply {load(null)}
  (store.getKey(alias,null) as? SecretKey)?.let {return it}
  return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
   init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
  }.generateKey()
 }
 private fun storageKey(token:String):String {
  val claims=JSONObject(String(Base64.decode(token.split('.')[1],Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),Charsets.UTF_8))
  val subject=claims.getString("sub");require(subject.startsWith("google-oauth2|"))
  return MessageDigest.getInstance("SHA-256").digest((scope+"\n"+subject).toByteArray()).joinToString("") {"%02x".format(it)}
 }
 private fun read(partition:String):JSONObject? {
  val encoded=prefs.getString(partition,null) ?: return null
  val bytes=Base64.decode(encoded,Base64.NO_WRAP);require(bytes.size>28)
  val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)));cipher.updateAAD(partition.toByteArray())
  return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8))
 }
 private fun write(partition:String,value:JSONObject) {
  val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD(partition.toByteArray())
  check(prefs.edit().putString(partition,Base64.encodeToString(cipher.iv+cipher.doFinal(value.toString().toByteArray()),Base64.NO_WRAP)).commit())
 }
 private fun post(path:String,token:String,body:JSONObject):JSONObject {
  val url=URL(origin+path);require(url.protocol=="https")
  val connection=url.openConnection() as HttpsURLConnection
  try {
   connection.instanceFollowRedirects=false;connection.connectTimeout=15000;connection.readTimeout=15000
   connection.requestMethod="POST";connection.doOutput=true
   connection.setRequestProperty("Authorization","Bearer $token");connection.setRequestProperty("Content-Type","application/json")
   connection.outputStream.use {it.write(body.toString().toByteArray())}
   check(connection.responseCode in 200..299) {"Installation authentication failed"}
   val bytes=connection.inputStream.use { input ->
    val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
    while(true) {val count=input.read(buffer);if(count<0)break;require(output.size()+count<=65536);output.write(buffer,0,count)}
    output.toByteArray()
   }
   return JSONObject(String(bytes,Charsets.UTF_8))
  } finally {connection.disconnect()}
 }
 val session=InstallationSession(::read,::write,::post,::storageKey,"${Build.MANUFACTURER} ${Build.MODEL}")
 fun panel(deviceId:String):String {require(java.util.UUID.fromString(deviceId).toString()==deviceId);return "$origin/access?device=$deviceId"}
}
