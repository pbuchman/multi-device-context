package com.multidevicecontext.mobile
object NativePolicy {
 const val MAX_TEXT=262144
 const val MAX_FILE=104857600L
 const val MAX_INBOX=268435456L
 const val MAX_CHUNK=262144
 private val link=Regex("^multi-device-context://context/((?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff))$")
 fun contextId(value:String?):String? = value?.let { link.matchEntire(it)?.groupValues?.get(1)?.lowercase() }
 fun validShare(text:String?,sizes:List<Long>,used:Long):Boolean =
  (!text.isNullOrBlank() || sizes.isNotEmpty()) && (text?.toByteArray(Charsets.UTF_8)?.size ?: 0)<=MAX_TEXT &&
  sizes.size<=32 && sizes.all { it in 1..MAX_FILE } && sizes.sum()<=MAX_FILE &&
  used+sizes.sum()+(text?.toByteArray(Charsets.UTF_8)?.size ?: 0)<=MAX_INBOX
 private val mime=Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
 fun safeMime(value:String):String = if(mime.matches(value)) value else "application/octet-stream"
 fun safeName(value:String):String = value.replace('\\','/').substringAfterLast('/').filter { it.code>=32 && it.code !in 127..159 }.take(255).let { if(it.isNotEmpty() && Character.isHighSurrogate(it.last())) it.dropLast(1) else it }.ifBlank { "file" }.let { if(it=="." || it=="..") "file" else it }
}
