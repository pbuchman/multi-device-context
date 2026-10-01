package com.multidevicecontext.mobile
import android.app.Activity
import android.content.Context
import com.auth0.android.Auth0
import com.auth0.android.authentication.AuthenticationAPIClient
import com.auth0.android.authentication.AuthenticationException
import com.auth0.android.authentication.storage.SecureCredentialsManager
import com.auth0.android.authentication.storage.SharedPreferencesStorage
import com.auth0.android.authentication.storage.CredentialsManagerException
import com.auth0.android.callback.Callback
import com.auth0.android.provider.WebAuthProvider
import com.auth0.android.result.Credentials
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall

class NativeAuth(activity:Activity) {
 private var activityRef=java.lang.ref.WeakReference(activity)
 private val appContext=activity.applicationContext
 private val main=android.os.Handler(android.os.Looper.getMainLooper())
 private val account=Auth0.getInstance(activity.getString(R.string.com_auth0_client_id),activity.getString(R.string.com_auth0_domain))
 private val storage=FencedStorage(SharedPreferencesStorage(appContext))
 private val manager=SecureCredentialsManager(AuthenticationAPIClient(account),appContext,storage)
 private val gate=AuthGate<PluginCall>()
 private var refreshing=false
 private var signedOutDuringRefresh=false
 fun attach(next:Activity) { activityRef=java.lang.ref.WeakReference(next) }
 fun token(call:PluginCall) { main.post {
  if(refreshing && signedOutDuringRefresh) {call.reject("Sign out is finishing; retry shortly");return@post}
  val generation=gate.add(call) ?: return@post
  storage.allowWrites()
  signedOutDuringRefresh=false
  refreshing=true
  manager.getCredentials(object:Callback<Credentials,CredentialsManagerException> {
   override fun onSuccess(result:Credentials) { main.post { refreshing=false;complete(generation,result) } }
   override fun onFailure(error:CredentialsManagerException) { main.post {
    refreshing=false
    if(!gate.isCurrent(generation)) { manager.clearCredentials();return@post }
    if(call.getBoolean("interactive",false)==true) login(generation)
    else gate.finish(generation).forEach { it.reject("Sign in required","AUTH_REQUIRED") }
   } }
  })
 } }
 private fun complete(generation:Long,credentials:Credentials) {
  if(!gate.isCurrent(generation)) { manager.clearCredentials();return }
  gate.finish(generation).forEach { it.resolve(JSObject().put("accessToken",credentials.accessToken)) }
 }
 private fun login(generation:Long) {
  val activity=activityRef.get() ?: run { gate.finish(generation).forEach { it.reject("Activity unavailable") };return }
  WebAuthProvider.login(account).withScheme("com.multidevicecontext.mobile")
   .withAudience(activity.getString(R.string.mdc_audience)).withConnection(activity.getString(R.string.mdc_connection))
   .withScope("openid profile email offline_access").start(activity,object:Callback<Credentials,AuthenticationException> {
    override fun onSuccess(result:Credentials) { main.post {
     if(!gate.isCurrent(generation))return@post
     try { manager.saveCredentials(result);complete(generation,result) } catch(_:Exception) { gate.finish(generation).forEach { it.reject("Could not securely save credentials") } }
    } }
    override fun onFailure(error:AuthenticationException) { main.post { gate.finish(generation).forEach { it.reject("Sign in cancelled or failed","AUTH_REQUIRED") } } }
   })
 }
 fun signOut() { signedOutDuringRefresh=refreshing;gate.signOut().forEach { it.reject("Signed out","AUTH_REQUIRED") };storage.blockWrites { manager.clearCredentials() } }
}
