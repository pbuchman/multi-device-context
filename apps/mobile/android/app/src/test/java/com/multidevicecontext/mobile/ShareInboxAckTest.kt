package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
class ShareInboxAckTest {
 @Test fun recreationCannotReimportAlreadyAcknowledgedIntent() {
  val root=java.nio.file.Files.createTempDirectory("ack").toFile();val inbox=ShareInbox(root);val id=java.util.UUID.randomUUID().toString()
  inbox.capture(id,"hello",emptyList());inbox.acknowledge(id)
  ShareInbox(root).capture(id,"hello",emptyList());assertEquals(0,ShareInbox(root).pending().length());root.deleteRecursively()
 }
}
