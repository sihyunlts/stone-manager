package com.stone.manager

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.IOException
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.BLUETOOTH_SCAN], alias = "scan"),
    Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "connect"),
    Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location")
  ]
)
class StoneBluetoothPlugin(private val hostActivity: Activity) : Plugin(hostActivity) {
  private data class DeviceSession(
    val address: String,
    @Volatile var name: String,
    @Volatile var link: Boolean = false,
    @Volatile var rfcomm: Boolean = false,
    @Volatile var socket: BluetoothSocket? = null,
    @Volatile var readerThread: Thread? = null,
  )

  private data class PendingInvokeAction(
    val requireEnabledAdapter: Boolean,
    val action: (Invoke) -> Unit,
  )

  private data class BondSession(
    val latch: CountDownLatch = CountDownLatch(1),
    @Volatile var outcome: Int? = null,
  )

  private data class ScanSession(
    val results: ConcurrentHashMap<String, Map<String, Any?>> = ConcurrentHashMap(),
    val latch: CountDownLatch = CountDownLatch(1),
  )

  private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val sessions = ConcurrentHashMap<String, DeviceSession>()
  private val pendingActions = ConcurrentHashMap<Long, PendingInvokeAction>()
  private val pendingBonds = ConcurrentHashMap<String, BondSession>()
  private val pendingConnects = ConcurrentHashMap.newKeySet<String>()
  private val scanLock = Any()

  @Volatile
  private var pendingScan: ScanSession? = null

  @Volatile
  private var receiverRegistered = false

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.action) {
        BluetoothDevice.ACTION_FOUND -> handleDiscoveryFound(intent)
        BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
          val session = pendingScan ?: return
          completeScanSession(session, cancelDiscovery = false)
        }
        BluetoothDevice.ACTION_BOND_STATE_CHANGED -> handleBondStateChanged(intent)
        BluetoothDevice.ACTION_ACL_CONNECTED -> handleAclEvent(intent, connected = true)
        BluetoothDevice.ACTION_ACL_DISCONNECTED -> handleAclEvent(intent, connected = false)
      }
    }
  }

  override fun load(webView: WebView) {
    registerReceiverIfNeeded()
  }

  override fun onDestroy() {
    if (receiverRegistered) {
      try {
        hostActivity.unregisterReceiver(receiver)
      } catch (_: IllegalArgumentException) {
      }
      receiverRegistered = false
    }
    stopDiscoveryQuietly()
    sessions.keys.toList().forEach { address ->
      closeSession(address, emitEvent = false)
    }
    ioExecutor.shutdownNow()
  }

  @Command
  fun listDevices(invoke: Invoke) {
    ensureBluetoothReady(invoke, requireEnabledAdapter = true) { readyInvoke ->
      ioExecutor.execute {
        try {
          readyInvoke.resolveObject(buildBondedDeviceList())
        } catch (err: Exception) {
          readyInvoke.reject(err.message ?: "Failed to list devices", err)
        }
      }
    }
  }

  @Command
  fun scanUnpairedStoneDevices(invoke: Invoke) {
    ensureBluetoothReady(invoke, requireEnabledAdapter = true) { readyInvoke ->
      ioExecutor.execute {
        try {
          readyInvoke.resolveObject(scanUnpairedStoneDevicesBlocking())
        } catch (err: Exception) {
          readyInvoke.reject(err.message ?: "Failed to scan devices", err)
        }
      }
    }
  }

  @Command
  fun getConnectionInfos(invoke: Invoke) {
    invoke.resolveObject(connectionSnapshots())
  }

  @Command
  fun connectDevice(invoke: Invoke) {
    val address = normalizedAddress(invoke.getArgs().getString("address"))
    if (address.isEmpty()) {
      invoke.reject("Invalid address")
      return
    }
    ensureBluetoothReady(invoke, requireEnabledAdapter = true) { readyInvoke ->
      ioExecutor.execute {
        try {
          connectDeviceBlocking(address)
          readyInvoke.resolve()
        } catch (err: Exception) {
          readyInvoke.reject(err.message ?: "Connect failed", err)
        }
      }
    }
  }

  @Command
  fun disconnectDevice(invoke: Invoke) {
    val address = normalizedAddress(invoke.getArgs().getString("address"))
    if (address.isEmpty()) {
      invoke.reject("Invalid address")
      return
    }
    ioExecutor.execute {
      try {
        closeSession(address, emitEvent = true)
        invoke.resolve()
      } catch (err: Exception) {
        invoke.reject(err.message ?: "Disconnect failed", err)
      }
    }
  }

  @Command
  fun sendGaiaCommand(invoke: Invoke) {
    val args = invoke.getArgs()
    val address = normalizedAddress(args.getString("address"))
    if (address.isEmpty()) {
      invoke.reject("Invalid address")
      return
    }
    val payloadJson = args.optJSONArray("data")
    val bytes = ByteArray(payloadJson?.length() ?: 0) { index ->
      (payloadJson?.optInt(index) ?: 0).toByte()
    }
    ensureBluetoothReady(invoke, requireEnabledAdapter = true) { readyInvoke ->
      ioExecutor.execute {
        try {
          writeToSocket(address, bytes)
          readyInvoke.resolve()
        } catch (err: Exception) {
          closeSession(address, emitEvent = true)
          readyInvoke.reject(err.message ?: "Write failed", err)
        }
      }
    }
  }

  @PermissionCallback
  fun onBluetoothPermissionsResult(invoke: Invoke) {
    if (!hasRequiredRuntimePermissions()) {
      pendingActions.remove(invoke.id)
      invoke.reject("Bluetooth permission denied")
      return
    }
    resumePendingAction(invoke)
  }

  @ActivityCallback
  fun onBluetoothEnableResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK || !isAdapterEnabled()) {
      pendingActions.remove(invoke.id)
      invoke.reject("Bluetooth must be enabled")
      return
    }
    resumePendingAction(invoke)
  }

  private external fun nativeOnData(address: String, data: ByteArray)

  private external fun nativeOnDeviceEvent(address: String, connected: Boolean)

  private fun ensureBluetoothReady(
    invoke: Invoke,
    requireEnabledAdapter: Boolean,
    action: (Invoke) -> Unit,
  ) {
    if (getAdapter() == null) {
      invoke.reject("Bluetooth adapter unavailable")
      return
    }
    pendingActions[invoke.id] = PendingInvokeAction(
      requireEnabledAdapter = requireEnabledAdapter,
      action = action,
    )
    resumePendingAction(invoke)
  }

  private fun resumePendingAction(invoke: Invoke) {
    val pending = pendingActions[invoke.id] ?: return
    if (!hasRequiredRuntimePermissions()) {
      requestBluetoothPermissions(invoke)
      return
    }
    if (pending.requireEnabledAdapter && !isAdapterEnabled()) {
      requestBluetoothEnable(invoke)
      return
    }
    pendingActions.remove(invoke.id)?.action?.invoke(invoke)
  }

  private fun requestBluetoothPermissions(invoke: Invoke) {
    val aliases = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf("scan", "connect")
    } else {
      arrayOf("location")
    }
    requestPermissionForAliases(aliases, invoke, "onBluetoothPermissionsResult")
  }

  private fun requestBluetoothEnable(invoke: Invoke) {
    startActivityForResult(
      invoke,
      Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),
      "onBluetoothEnableResult"
    )
  }

  private fun registerReceiverIfNeeded() {
    if (receiverRegistered) {
      return
    }
    val filter = IntentFilter().apply {
      addAction(BluetoothDevice.ACTION_FOUND)
      addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
      addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
      addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
      addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      hostActivity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      hostActivity.registerReceiver(receiver, filter)
    }
    receiverRegistered = true
  }

  private fun handleDiscoveryFound(intent: Intent) {
    val session = pendingScan ?: return
    val device = bluetoothDeviceFromIntent(intent) ?: return
    val address = normalizedAddress(device.address)
    if (address.isEmpty() || device.bondState == BluetoothDevice.BOND_BONDED) {
      return
    }
    val name = safeDeviceName(device)
    if (!isStoneCandidate(name, address)) {
      return
    }
    session.results[address] = deviceMap(
      name = name.ifEmpty { address },
      address = address,
      connected = false,
      hasGaia = true,
      paired = false,
    )
  }

  private fun handleBondStateChanged(intent: Intent) {
    val device = bluetoothDeviceFromIntent(intent) ?: return
    val address = normalizedAddress(device.address)
    val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
    if (state != BluetoothDevice.BOND_BONDED && state != BluetoothDevice.BOND_NONE) {
      return
    }
    pendingBonds[address]?.let { session ->
      session.outcome = state
      session.latch.countDown()
    }
  }

  private fun handleAclEvent(intent: Intent, connected: Boolean) {
    val device = bluetoothDeviceFromIntent(intent) ?: return
    val address = normalizedAddress(device.address)
    if (address.isEmpty()) {
      return
    }
    val name = safeDeviceName(device).ifEmpty { address }
    if (!isStoneCandidate(name, address) && !sessions.containsKey(address)) {
      return
    }
    if (connected) {
      val session = sessions[address]
      if (session == null) {
        sessions[address] = DeviceSession(
          address = address,
          name = name,
          link = true,
          rfcomm = false,
        )
      } else {
        session.name = name
        session.link = true
      }
      if (!pendingConnects.contains(address)) {
        nativeOnDeviceEvent(address, true)
      }
    } else {
      closeSession(address, emitEvent = true)
    }
  }

  private fun buildBondedDeviceList(): List<Map<String, Any?>> {
    val bondedDevices = getAdapter()?.bondedDevices.orEmpty()
    return bondedDevices
      .map { device ->
        val address = normalizedAddress(device.address)
        val session = sessionForDeviceSnapshot(device)
        val name = safeDeviceName(device).ifEmpty { address }
        deviceMap(
          name = name,
          address = address,
          connected = session?.link == true || session?.rfcomm == true,
          hasGaia = isStoneCandidate(name, address),
          paired = true,
        )
      }
      .sortedWith(compareBy({ (it["name"] as? String)?.lowercase(Locale.US).orEmpty() }, { it["address"] as? String }))
  }

  private fun connectionSnapshots(): List<Map<String, Any?>> {
    getAdapter()?.bondedDevices
      ?.forEach { device ->
        sessionForDeviceSnapshot(device)
      }
    return sessions.values
      .filter { it.link || it.rfcomm }
      .sortedBy { it.address }
      .map { session ->
        mapOf(
          "address" to session.address,
          "link" to session.link,
          "rfcomm" to session.rfcomm,
        )
      }
  }

  @Throws(IOException::class, InterruptedException::class)
  private fun scanUnpairedStoneDevicesBlocking(): List<Map<String, Any?>> {
    val adapter = requireAdapter()
    val session = synchronized(scanLock) {
      if (pendingScan != null) {
        throw IOException("Scan already in progress")
      }
      ScanSession().also { pendingScan = it }
    }

    stopDiscoveryQuietly()
    if (!adapter.startDiscovery()) {
      synchronized(scanLock) {
        if (pendingScan === session) {
          pendingScan = null
        }
      }
      throw IOException("Failed to start device discovery")
    }

    mainHandler.postDelayed(
      { completeScanSession(session, cancelDiscovery = true) },
      SCAN_WINDOW_MS
    )

    session.latch.await(SCAN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    completeScanSession(session, cancelDiscovery = false)

    return session.results.values
      .sortedWith(compareBy({ (it["name"] as? String)?.lowercase(Locale.US).orEmpty() }, { it["address"] as? String }))
      .toList()
  }

  private fun completeScanSession(session: ScanSession, cancelDiscovery: Boolean) {
    synchronized(scanLock) {
      if (pendingScan !== session) {
        return
      }
      pendingScan = null
    }
    if (cancelDiscovery) {
      stopDiscoveryQuietly()
    }
    session.latch.countDown()
  }

  @Throws(IOException::class, InterruptedException::class)
  private fun connectDeviceBlocking(address: String) {
    val adapter = requireAdapter()
    val existing = sessions[address]
    if (existing?.rfcomm == true && existing.socket?.isConnected == true) {
      existing.link = true
      return
    }

    val device = try {
      adapter.getRemoteDevice(address)
    } catch (err: IllegalArgumentException) {
      throw IOException("Invalid Bluetooth address", err)
    }

    pendingConnects.add(address)
    try {
      stopDiscoveryQuietly()
      ensureBonded(device)

      val socket = createGaiaSocket(device)
      try {
        socket.connect()
      } catch (err: IOException) {
        closeQuietly(socket)
        throw IOException("RFCOMM connection failed: ${err.message ?: "unknown error"}", err)
      }

      val session = sessions[address]
      if (session?.socket != null && session.socket !== socket) {
        closeQuietly(session.socket)
      }

      val updated = DeviceSession(
        address = address,
        name = safeDeviceName(device).ifEmpty { address },
        link = true,
        rfcomm = true,
        socket = socket,
      )
      sessions[address] = updated
      startReader(updated)
    } finally {
      pendingConnects.remove(address)
    }
  }

  @Throws(IOException::class, InterruptedException::class)
  private fun ensureBonded(device: BluetoothDevice) {
    val address = normalizedAddress(device.address)
    when (device.bondState) {
      BluetoothDevice.BOND_BONDED -> return
      BluetoothDevice.BOND_BONDING -> {
        val session = pendingBonds[address] ?: BondSession().also { pendingBonds[address] = it }
        waitForBond(address, session)
        return
      }
    }

    val session = BondSession()
    pendingBonds[address] = session
    if (!device.createBond()) {
      pendingBonds.remove(address)
      throw IOException("Failed to start pairing")
    }
    waitForBond(address, session)
  }

  @Throws(IOException::class, InterruptedException::class)
  private fun waitForBond(address: String, session: BondSession) {
    val completed = session.latch.await(BOND_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    pendingBonds.remove(address, session)
    if (!completed) {
      throw IOException("Pairing timed out")
    }
    if (session.outcome != BluetoothDevice.BOND_BONDED) {
      throw IOException("Pairing was cancelled")
    }
  }

  @Throws(IOException::class)
  private fun createGaiaSocket(device: BluetoothDevice): BluetoothSocket {
    try {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.GINGERBREAD_MR1) {
        device.createInsecureRfcommSocketToServiceRecord(GAIA_UUID)
      } else {
        @Suppress("DEPRECATION")
        device.createRfcommSocketToServiceRecord(GAIA_UUID)
      }
    } catch (primary: IOException) {
      try {
        val method = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
        return method.invoke(device, 1) as BluetoothSocket
      } catch (fallback: Exception) {
        throw IOException("Unable to create RFCOMM socket", fallback)
      }
    }
  }

  @Throws(IOException::class)
  private fun writeToSocket(address: String, data: ByteArray) {
    val session = sessions[address]
    val socket = session?.socket
    if (session?.rfcomm != true || socket == null || !socket.isConnected) {
      throw IOException("Target device is not connected")
    }
    socket.outputStream.write(data)
    socket.outputStream.flush()
  }

  private fun startReader(session: DeviceSession) {
    session.readerThread?.interrupt()
    val socket = session.socket ?: return
    val reader = Thread({
      val buffer = ByteArray(1024)
      try {
        val input = socket.inputStream
        while (!Thread.currentThread().isInterrupted) {
          val read = input.read(buffer)
          if (read <= 0) {
            break
          }
          nativeOnData(session.address, buffer.copyOf(read))
        }
      } catch (err: IOException) {
        Log.d(TAG, "Reader stopped for ${session.address}: ${err.message}")
      } finally {
        closeSession(session.address, emitEvent = true)
      }
    }, "stone-gaia-reader-${session.address}")
    session.readerThread = reader
    reader.isDaemon = true
    reader.start()
  }

  private fun closeSession(address: String, emitEvent: Boolean) {
    val session = sessions.remove(address)
    session?.readerThread?.interrupt()
    session?.readerThread = null
    closeQuietly(session?.socket)
    session?.socket = null
    session?.rfcomm = false
    session?.link = false
    if (emitEvent && session != null) {
      nativeOnDeviceEvent(address, false)
    }
  }

  private fun stopDiscoveryQuietly() {
    val adapter = getAdapter() ?: return
    try {
      if (adapter.isDiscovering) {
        adapter.cancelDiscovery()
      }
    } catch (_: SecurityException) {
    }
  }

  private fun hasRequiredRuntimePermissions(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      hasPermission(Manifest.permission.BLUETOOTH_SCAN) &&
        hasPermission(Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
    }
  }

  private fun hasPermission(permission: String): Boolean {
    return hostActivity.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED
  }

  @Throws(IOException::class)
  private fun requireAdapter(): BluetoothAdapter {
    return getAdapter() ?: throw IOException("Bluetooth adapter unavailable")
  }

  private fun getAdapter(): BluetoothAdapter? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
      hostActivity.getSystemService(BluetoothManager::class.java)?.adapter
    } else {
      @Suppress("DEPRECATION")
      BluetoothAdapter.getDefaultAdapter()
    }
  }

  private fun isAdapterEnabled(): Boolean {
    return getAdapter()?.isEnabled == true
  }

  private fun isStoneCandidate(name: String?, address: String): Boolean {
    val trimmedName = name?.trim().orEmpty()
    if (trimmedName.startsWith(STONE_NAME_PREFIX, ignoreCase = true)) {
      return true
    }
    val normalizedAddress = normalizedAddress(address)
    return STONE_VENDOR_PREFIXES.any { normalizedAddress.startsWith(it) }
  }

  private fun deviceMap(
    name: String,
    address: String,
    connected: Boolean,
    hasGaia: Boolean,
    paired: Boolean,
  ): Map<String, Any?> {
    return mapOf(
      "name" to name,
      "address" to address,
      "connected" to connected,
      "has_gaia" to hasGaia,
      "paired" to paired,
    )
  }

  private fun safeDeviceName(device: BluetoothDevice): String {
    return try {
      device.name ?: ""
    } catch (_: SecurityException) {
      ""
    }
  }

  private fun sessionForDeviceSnapshot(device: BluetoothDevice): DeviceSession? {
    val address = normalizedAddress(device.address)
    if (address.isEmpty()) {
      return null
    }
    val name = safeDeviceName(device).ifEmpty { address }
    val session = sessions[address]
    val linkConnected = isDeviceConnected(device) || session?.rfcomm == true
    if (!linkConnected) {
      if (session != null && session.rfcomm) {
        session.link = true
        session.name = name
        return session
      }
      return session
    }

    if (session == null) {
      return DeviceSession(
        address = address,
        name = name,
        link = true,
        rfcomm = false,
      ).also { sessions[address] = it }
    }

    session.name = name
    session.link = true
    return session
  }

  private fun isDeviceConnected(device: BluetoothDevice): Boolean {
    return try {
      val method = device.javaClass.getMethod("isConnected")
      (method.invoke(device) as? Boolean) == true
    } catch (_: Exception) {
      false
    }
  }

  private fun normalizedAddress(address: String?): String {
    return address?.trim()?.uppercase(Locale.US).orEmpty()
  }

  private fun bluetoothDeviceFromIntent(intent: Intent): BluetoothDevice? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
    }
  }

  private fun closeQuietly(socket: BluetoothSocket?) {
    try {
      socket?.close()
    } catch (_: IOException) {
    }
  }

  companion object {
    private const val TAG = "StoneBluetoothPlugin"
    private const val STONE_NAME_PREFIX = "STONE"
    private const val SCAN_WINDOW_MS = 5_000L
    private const val SCAN_TIMEOUT_MS = 12_000L
    private const val BOND_TIMEOUT_MS = 30_000L
    private val GAIA_UUID: UUID = UUID.fromString("00001107-D102-11E1-9B23-00025B00A5A5")
    private val STONE_VENDOR_PREFIXES = setOf("2C:30:68", "00:02:5B")
  }
}
