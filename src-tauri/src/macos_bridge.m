#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOBluetooth/IOBluetoothTypes.h>
#import <IOBluetooth/objc/IOBluetoothRFCOMMChannel.h>
#import <IOBluetooth/objc/IOBluetoothSDPServiceRecord.h>

#define BTLOG(fmt, ...)                                                                                 \
    do {                                                                                               \
        NSLog((@"[STONE][BACK][BT] " fmt), ##__VA_ARGS__);                                            \
    } while (0)

extern void macos_bt_on_data(const char *address, const uint8_t *data, size_t len);
extern void macos_bt_on_device_event(const char *address, int connected);

static IOBluetoothDevice *findDeviceForAddress(NSString *address);
static const NSTimeInterval kStoneOpTimeout = 10.0;

static void runOnMainSync(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }
    dispatch_sync(dispatch_get_main_queue(), block);
}

static NSString *normalizedAddress(NSString *address) {
    if (!address) {
        return @"";
    }
    return [[address lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static id jsonBool(BOOL value) {
    return value ? (id)kCFBooleanTrue : (id)kCFBooleanFalse;
}

static IOBluetoothSDPUUID *stoneGaiaSDPUUID(void) {
    static IOBluetoothSDPUUID *uuid = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        const uint8_t bytes[] = {0x00, 0x00, 0x11, 0x07, 0xD1, 0x02, 0x11, 0xE1,
                                 0x9B, 0x23, 0x00, 0x02, 0x5B, 0x00, 0xA5, 0xA5};
        uuid = [IOBluetoothSDPUUID uuidWithBytes:bytes length:sizeof(bytes)];
    });
    return uuid;
}

static char *jsonCStringFromObject(id object, const char *fallbackJson) {
    NSError *error = nil;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (!jsonData || error) {
        return strdup(fallbackJson);
    }
    NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (!jsonString) {
        return strdup(fallbackJson);
    }
    return strdup([jsonString UTF8String]);
}

@interface StoneDeviceInquiryCollector : NSObject <IOBluetoothDeviceInquiryDelegate>
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *entriesByAddress;
@property (nonatomic, assign) BOOL completed;
@property (nonatomic, strong) dispatch_semaphore_t doneSemaphore;
@end

@interface StoneDeviceSession : NSObject
@property (nonatomic, copy) NSString *addressKey;
@property (nonatomic, strong) IOBluetoothDevice *device;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property (nonatomic, assign) BOOL pendingSDPDone;
@property (nonatomic, assign) IOReturn pendingSDPStatus;
@end

@interface StoneBluetoothManager : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, copy) NSString *lastErrorContext;
@property (nonatomic, strong) IOBluetoothUserNotification *connectNotification;
@property (nonatomic, strong) NSMutableDictionary<NSString *, IOBluetoothUserNotification *> *disconnectNotifications;
@property (nonatomic, strong) NSMutableDictionary<NSString *, StoneDeviceSession *> *sessionsByAddress;

@property (nonatomic, strong) IOBluetoothDeviceInquiry *scanInquiry;
@property (nonatomic, strong) StoneDeviceInquiryCollector *scanCollector;
@end

@implementation StoneDeviceSession
@end

@implementation StoneDeviceInquiryCollector

- (instancetype)init {
    self = [super init];
    if (self) {
        _entriesByAddress = [NSMutableDictionary dictionary];
        _completed = NO;
    }
    return self;
}

- (void)addCandidate:(IOBluetoothDevice *)device {
    if (!device || [device isPaired]) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    if (address.length == 0) {
        return;
    }

    NSString *name = device.name ?: @"";
    if (![[name uppercaseString] containsString:@"STONE"]) {
        return;
    }

    NSString *key = normalizedAddress(address);
    self.entriesByAddress[key] = @{
        @"name" : (name.length > 0 ? name : @"(unknown)"),
        @"address" : address,
        @"connected" : jsonBool([device isConnected]),
        @"has_gaia" : jsonBool(NO),
        @"paired" : jsonBool(NO)
    };
}

- (void)deviceInquiryDeviceFound:(IOBluetoothDeviceInquiry *)sender device:(IOBluetoothDevice *)device {
    (void)sender;
    [self addCandidate:device];
}

- (void)deviceInquiryDeviceNameUpdated:(IOBluetoothDeviceInquiry *)sender
                                device:(IOBluetoothDevice *)device
                      devicesRemaining:(uint32_t)devicesRemaining {
    (void)sender;
    (void)devicesRemaining;
    [self addCandidate:device];
}

- (void)deviceInquiryComplete:(IOBluetoothDeviceInquiry *)sender error:(IOReturn)error aborted:(BOOL)aborted {
    (void)sender;
    (void)aborted;
    (void)error;
    self.completed = YES;
    if (self.doneSemaphore) {
        dispatch_semaphore_signal(self.doneSemaphore);
    }
}

@end

@implementation StoneBluetoothManager

+ (instancetype)shared {
    static StoneBluetoothManager *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[StoneBluetoothManager alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _disconnectNotifications = [NSMutableDictionary dictionary];
        _sessionsByAddress = [NSMutableDictionary dictionary];
        _lastErrorContext = @"";
    }
    return self;
}

- (void)ensureConnectionNotifications {
    if (!self.connectNotification) {
        self.connectNotification = [IOBluetoothDevice registerForConnectNotifications:self
                                                                             selector:@selector(deviceConnected:device:)];
    }

    if (!self.disconnectNotifications) {
        self.disconnectNotifications = [NSMutableDictionary dictionary];
    }

    NSArray *paired = [IOBluetoothDevice pairedDevices] ?: @[];
    for (IOBluetoothDevice *pairedDevice in paired) {
        if ([pairedDevice isConnected]) {
            [self registerDisconnectNotification:pairedDevice];
        }
    }
}

- (void)stopActiveInquiryIfNeeded {
    runOnMainSync(^{
        if (self.scanInquiry) {
            BTLOG(@"Stop active inquiry before connect");
            (void)[self.scanInquiry stop];
            self.scanInquiry = nil;
            self.scanCollector = nil;
        }
    });
}

- (void)registerDisconnectNotification:(IOBluetoothDevice *)device {
    if (!device) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    if (address.length == 0) {
        return;
    }

    NSString *key = normalizedAddress(address);
    if (self.disconnectNotifications[key]) {
        return;
    }

    IOBluetoothUserNotification *note =
        [device registerForDisconnectNotification:self selector:@selector(deviceDisconnected:device:)];
    if (note) {
        self.disconnectNotifications[key] = note;
    }
}

- (void)unregisterDisconnectNotificationForAddress:(NSString *)address {
    NSString *key = normalizedAddress(address);
    if (key.length == 0) {
        return;
    }

    IOBluetoothUserNotification *note = self.disconnectNotifications[key];
    if (note) {
        [note unregister];
        [self.disconnectNotifications removeObjectForKey:key];
    }
}

- (StoneDeviceSession *)sessionForAddressKey:(NSString *)addressKey createIfNeeded:(BOOL)createIfNeeded {
    NSString *key = normalizedAddress(addressKey);
    if (key.length == 0) {
        return nil;
    }

    StoneDeviceSession *session = self.sessionsByAddress[key];
    if (!session && createIfNeeded) {
        session = [[StoneDeviceSession alloc] init];
        session.addressKey = key;
        session.pendingSDPDone = NO;
        session.pendingSDPStatus = kIOReturnError;
        self.sessionsByAddress[key] = session;
    }
    return session;
}

- (StoneDeviceSession *)sessionForAddress:(NSString *)address createIfNeeded:(BOOL)createIfNeeded {
    return [self sessionForAddressKey:normalizedAddress(address) createIfNeeded:createIfNeeded];
}

- (StoneDeviceSession *)sessionForDevice:(IOBluetoothDevice *)device createIfNeeded:(BOOL)createIfNeeded {
    if (!device) {
        return nil;
    }
    NSString *address = device.addressString ?: @"";
    StoneDeviceSession *session = [self sessionForAddress:address createIfNeeded:createIfNeeded];
    if (session) {
        session.device = device;
    }
    return session;
}

- (void)removeSessionIfInactive:(NSString *)addressKey {
    StoneDeviceSession *session = [self sessionForAddressKey:addressKey createIfNeeded:NO];
    if (!session) {
        return;
    }

    BOOL link = session.device && [session.device isConnected];
    BOOL rfcomm = session.channel && [session.channel isOpen];
    if (!link && !rfcomm) {
        [self.sessionsByAddress removeObjectForKey:session.addressKey ?: normalizedAddress(addressKey)];
    }
}

- (BOOL)waitForDevice:(IOBluetoothDevice *)device connected:(BOOL)connected timeout:(NSTimeInterval)timeout {
    if (!device) {
        return NO;
    }

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (([device isConnected] != connected) && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return [device isConnected] == connected;
}

- (BOOL)disconnectSession:(StoneDeviceSession *)session timeout:(NSTimeInterval)timeout {
    if (!session) {
        return YES;
    }

    IOBluetoothRFCOMMChannel *channel = session.channel;
    IOBluetoothDevice *device = session.device;
    if (!device && channel) {
        device = [channel getDevice];
    }

    NSString *address = device.addressString ?: session.addressKey ?: @"";
    if (channel) {
        BTLOG(@"RFCOMM close (%@)", address);
        [channel closeChannel];
        session.channel = nil;
    }

    BOOL linkDown = YES;
    if (device && [device isConnected]) {
        BTLOG(@"Link close request: %@", address);
        IOReturn closeStatus = [device closeConnection];
        BTLOG(@"Link close status: %d (%@)", (int)closeStatus, address);
        linkDown = [self waitForDevice:device connected:NO timeout:timeout];
        BTLOG(@"Link disconnected: %@ (%@)", linkDown ? @"YES" : @"NO", address);
    }

    if (address.length > 0) {
        [self unregisterDisconnectNotificationForAddress:address];
    }

    if (linkDown) {
        session.device = nil;
        [self removeSessionIfInactive:session.addressKey ?: normalizedAddress(address)];
    }
    return linkDown;
}

- (IOReturn)performSDPQueryAndWaitForSession:(StoneDeviceSession *)session timeout:(NSTimeInterval)timeout {
    IOBluetoothDevice *device = session.device;
    if (!device || !session) {
        return kIOReturnBadArgument;
    }

    NSString *address = device.addressString ?: @"";
    @synchronized(session) {
        session.pendingSDPDone = NO;
        session.pendingSDPStatus = kIOReturnError;
    }

    NSDate *prevUpdate = [device getLastServicesUpdate];
    NSArray *uuids = @[ stoneGaiaSDPUUID() ];
    __block IOReturn kickStatus = kIOReturnError;
    runOnMainSync(^{
        kickStatus = [device performSDPQuery:self uuids:uuids];
    });
    BTLOG(@"SDP query kick: status=%d (%@)", (int)kickStatus, address);
    if (kickStatus != kIOReturnSuccess) {
        return kickStatus;
    }

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        BOOL done = NO;
        IOReturn doneStatus = kIOReturnError;

        @synchronized(session) {
            done = session.pendingSDPDone;
            doneStatus = session.pendingSDPStatus;
        }

        if (done) {
            return doneStatus;
        }

        NSDate *currentUpdate = [device getLastServicesUpdate];
        BOOL hasFreshUpdate =
            currentUpdate &&
            (!prevUpdate || [currentUpdate compare:prevUpdate] == NSOrderedDescending);
        if (hasFreshUpdate) {
            BluetoothRFCOMMChannelID channelID = [self resolveGaiaChannelID:device];
            if (channelID != 0) {
                BTLOG(@"SDP verified by services update (%@, ch=%d)", address, (int)channelID);
                return kIOReturnSuccess;
            }
        }

        [NSThread sleepForTimeInterval:0.05];
    }

    @synchronized(session) {
        if (session.pendingSDPDone) {
            return session.pendingSDPStatus;
        }
    }

    BluetoothRFCOMMChannelID fallbackChannel = [self resolveGaiaChannelID:device];
    if (fallbackChannel != 0) {
        BTLOG(@"SDP timeout fallback: using known GAIA channel (%@, ch=%d)", address, (int)fallbackChannel);
        return kIOReturnSuccess;
    }

    BTLOG(@"SDP query timeout (%@)", address);
    return kIOReturnTimeout;
}

- (IOReturn)ensureLinkConnected:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    if (!device) {
        return kIOReturnBadArgument;
    }

    if ([device isConnected]) {
        BTLOG(@"Link already connected (%@)", device.addressString ?: @"");
        return kIOReturnSuccess;
    }

    self.lastErrorContext = @"open_connection";
    IOReturn linkStatus = [device openConnection];
    BTLOG(@"Link request: status=%d (%@)", (int)linkStatus, device.addressString ?: @"");

    if (linkStatus != kIOReturnSuccess && linkStatus != kIOBluetoothConnectionAlreadyExists) {
        if (![device isConnected]) {
            self.lastErrorContext = @"open_connection_failed";
            return linkStatus;
        }
    }

    BOOL linkUp = [self waitForDevice:device connected:YES timeout:timeout];
    BTLOG(@"Link connected: %@ (%@)", linkUp ? @"YES" : @"NO", device.addressString ?: @"");
    if (!linkUp) {
        self.lastErrorContext = @"link_connect_timeout";
        return kIOReturnTimeout;
    }

    return kIOReturnSuccess;
}

- (IOReturn)ensureAuthenticatedIfNeeded:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    if (!device) {
        return kIOReturnBadArgument;
    }
    if ([device isPaired]) {
        return kIOReturnSuccess;
    }

    self.lastErrorContext = @"request_authentication";
    BTLOG(@"Device is not paired, requesting authentication (%@)", device.addressString ?: @"");

    __block IOReturn authStatus = kIOReturnError;
    runOnMainSync(^{
        authStatus = [device requestAuthentication];
    });
    BTLOG(@"Authentication result: status=%d paired=%@", (int)authStatus, [device isPaired] ? @"YES" : @"NO");

    if (authStatus == kIOReturnSuccess && [device isPaired]) {
        return kIOReturnSuccess;
    }

    // Give the system pairing flow a short grace window.
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        if ([device isPaired]) {
            return kIOReturnSuccess;
        }
        [NSThread sleepForTimeInterval:0.05];
    }

    if ([device isPaired]) {
        return kIOReturnSuccess;
    }
    self.lastErrorContext = @"authentication_failed";
    return authStatus != kIOReturnSuccess ? authStatus : kIOReturnNotPermitted;
}

- (BluetoothRFCOMMChannelID)resolveGaiaChannelID:(IOBluetoothDevice *)device {
    if (!device) {
        return 0;
    }

    IOBluetoothSDPServiceRecord *record = [device getServiceRecordForUUID:stoneGaiaSDPUUID()];
    if (!record) {
        return 0;
    }

    BluetoothRFCOMMChannelID channelID = 0;
    IOReturn status = [record getRFCOMMChannelID:&channelID];
    if (status != kIOReturnSuccess) {
        return 0;
    }

    return channelID;
}

- (IOReturn)openGaiaRFCOMMChannelForSession:(StoneDeviceSession *)session
                                  channelID:(BluetoothRFCOMMChannelID)channelID {
    IOBluetoothDevice *device = session.device;
    if (!session || !device || channelID == 0) {
        return kIOReturnBadArgument;
    }

    __block IOBluetoothRFCOMMChannel *openedChannel = nil;
    __block IOReturn status = kIOReturnError;
    runOnMainSync(^{
        status = [device openRFCOMMChannelSync:&openedChannel withChannelID:channelID delegate:self];
    });
    if (status != kIOReturnSuccess) {
        return status;
    }

    session.channel = openedChannel;
    return kIOReturnSuccess;
}

- (IOReturn)attachGaiaRFCOMMForSession:(StoneDeviceSession *)session timeout:(NSTimeInterval)timeout {
    IOBluetoothDevice *device = session.device;
    if (!session || !device) {
        return kIOReturnBadArgument;
    }

    self.lastErrorContext = @"sdp_query";
    IOReturn sdpStatus = [self performSDPQueryAndWaitForSession:session timeout:timeout];
    if (sdpStatus != kIOReturnSuccess) {
        self.lastErrorContext = @"sdp_query_failed";
        return sdpStatus;
    }

    self.lastErrorContext = @"resolve_gaia_channel";
    BluetoothRFCOMMChannelID channelID = [self resolveGaiaChannelID:device];
    if (channelID == 0) {
        self.lastErrorContext = @"gaia_channel_not_found";
        BTLOG(@"GAIA channel not found (%@)", device.addressString ?: @"");
        return kIOReturnNotFound;
    }

    if (session.channel) {
        [session.channel closeChannel];
        session.channel = nil;
    }

    self.lastErrorContext = @"open_rfcomm";
    BTLOG(@"Open RFCOMM: ch=%d (%@)", (int)channelID, device.addressString ?: @"");
    IOReturn rfcommStatus = [self openGaiaRFCOMMChannelForSession:session channelID:channelID];
    if (rfcommStatus != kIOReturnSuccess) {
        BTLOG(@"RFCOMM open failed on ch=%d: status=%d (%@)", (int)channelID, (int)rfcommStatus, device.addressString ?: @"");

        // Match original Android fallback behavior (direct channel 1).
        if (channelID != 1) {
            BTLOG(@"RFCOMM fallback try: ch=1 (%@)", device.addressString ?: @"");
            IOReturn fallbackStatus = [self openGaiaRFCOMMChannelForSession:session channelID:1];
            if (fallbackStatus == kIOReturnSuccess) {
                BTLOG(@"RFCOMM fallback success on ch=1 (%@)", device.addressString ?: @"");
                return kIOReturnSuccess;
            }
            BTLOG(@"RFCOMM fallback failed on ch=1: status=%d (%@)", (int)fallbackStatus, device.addressString ?: @"");
            rfcommStatus = fallbackStatus;
        }

        self.lastErrorContext = @"open_rfcomm_failed";
        return rfcommStatus;
    }

    return kIOReturnSuccess;
}

- (IOReturn)connectToAddress:(NSString *)address {
    [self ensureConnectionNotifications];
    [self stopActiveInquiryIfNeeded];

    NSString *targetAddress = normalizedAddress(address);
    if (targetAddress.length == 0) {
        self.lastErrorContext = @"invalid_address";
        return kIOReturnBadArgument;
    }

    const NSTimeInterval timeout = kStoneOpTimeout;

    IOBluetoothDevice *device = findDeviceForAddress(address);
    if (!device) {
        self.lastErrorContext = @"device_not_found";
        BTLOG(@"Device not found: %@", address);
        return kIOReturnNotFound;
    }

    StoneDeviceSession *session = [self sessionForAddressKey:targetAddress createIfNeeded:YES];
    if (!session) {
        self.lastErrorContext = @"invalid_address";
        return kIOReturnBadArgument;
    }
    session.device = device;
    [self registerDisconnectNotification:device];

    if (session.channel && [session.channel isOpen]) {
        self.lastErrorContext = @"already_connected";
        BTLOG(@"RFCOMM already open (%@)", device.addressString ?: @"");
        return kIOReturnSuccess;
    }

    BOOL hadExistingLink = [device isConnected];
    IOReturn linkStatus = [self ensureLinkConnected:device timeout:timeout];
    if (linkStatus != kIOReturnSuccess) {
        return linkStatus;
    }

    IOReturn authStatus = [self ensureAuthenticatedIfNeeded:device timeout:timeout];
    if (authStatus != kIOReturnSuccess) {
        return authStatus;
    }

    IOReturn attachStatus = [self attachGaiaRFCOMMForSession:session timeout:timeout];
    if (attachStatus != kIOReturnSuccess && hadExistingLink) {
        // App restart can leave a stale baseband link; reset once and retry.
        self.lastErrorContext = @"retry_after_link_reset";
        BTLOG(@"Attach failed on existing link: status=%d (%@). Resetting link once.",
              (int)attachStatus,
              device.addressString ?: @"");

        BOOL down = [self disconnectSession:session timeout:timeout];
        BTLOG(@"Link reset result: %@ (%@)", down ? @"YES" : @"NO", device.addressString ?: @"");
        if (!down) {
            self.lastErrorContext = @"disconnect_timeout";
            return kIOReturnTimeout;
        }

        session.device = device;
        [self registerDisconnectNotification:device];

        IOReturn reopenStatus = [self ensureLinkConnected:device timeout:timeout];
        if (reopenStatus != kIOReturnSuccess) {
            return reopenStatus;
        }

        attachStatus = [self attachGaiaRFCOMMForSession:session timeout:timeout];
    }

    if (attachStatus != kIOReturnSuccess) {
        return attachStatus;
    }

    self.lastErrorContext = @"connected";
    BTLOG(@"RFCOMM connected (%@)", device.addressString ?: @"");
    return kIOReturnSuccess;
}

- (IOReturn)disconnectAddress:(NSString *)address {
    NSString *key = normalizedAddress(address);
    if (key.length == 0) {
        self.lastErrorContext = @"invalid_address";
        return kIOReturnBadArgument;
    }

    StoneDeviceSession *session = [self sessionForAddressKey:key createIfNeeded:NO];
    if (!session) {
        IOBluetoothDevice *device = findDeviceForAddress(address);
        if (!device || ![device isConnected]) {
            self.lastErrorContext = @"already_disconnected";
            return kIOReturnSuccess;
        }
        session = [self sessionForAddressKey:key createIfNeeded:YES];
        session.device = device;
    }

    BOOL down = [self disconnectSession:session timeout:3.0];
    if (down) {
        self.lastErrorContext = @"disconnected";
        return kIOReturnSuccess;
    }

    self.lastErrorContext = @"disconnect_timeout";
    return kIOReturnTimeout;
}

- (IOReturn)sendDataToAddress:(NSString *)address data:(NSData *)data {
    if (!data || data.length == 0) {
        return kIOReturnBadArgument;
    }

    StoneDeviceSession *session = [self sessionForAddress:address createIfNeeded:NO];
    if (!session || !session.channel || ![session.channel isOpen]) {
        return kIOReturnNotOpen;
    }

    BluetoothRFCOMMMTU mtu = [session.channel getMTU];
    if (mtu == 0) {
        mtu = 127;
    }

    const uint8_t *bytes = data.bytes;
    NSUInteger remaining = data.length;

    while (remaining > 0) {
        UInt16 chunk = (UInt16)MIN(remaining, (NSUInteger)mtu);
        IOReturn status = [session.channel writeSync:(void *)bytes length:chunk];
        if (status != kIOReturnSuccess) {
            return status;
        }
        bytes += chunk;
        remaining -= chunk;
    }

    return kIOReturnSuccess;
}

- (NSArray<NSDictionary *> *)currentConnectionInfos {
    NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
    NSMutableArray<NSString *> *pruneKeys = [NSMutableArray array];

    for (NSString *key in self.sessionsByAddress) {
        StoneDeviceSession *session = self.sessionsByAddress[key];
        if (!session) {
            continue;
        }

        IOBluetoothDevice *device = session.device;
        if (!device && session.channel) {
            device = [session.channel getDevice];
            session.device = device;
        }

        NSString *address = device.addressString ?: session.addressKey ?: @"";
        BOOL link = device && [device isConnected];
        BOOL rfcomm = session.channel && [session.channel isOpen];
        if (address.length == 0 || (!link && !rfcomm)) {
            [pruneKeys addObject:key];
            continue;
        }

        [entries addObject:@{
            @"address" : address,
            @"link" : jsonBool(link),
            @"rfcomm" : jsonBool(rfcomm)
        }];
    }

    for (NSString *key in pruneKeys) {
        [self.sessionsByAddress removeObjectForKey:key];
    }

    return entries;
}

- (void)deviceConnected:(IOBluetoothUserNotification *)note device:(IOBluetoothDevice *)device {
    (void)note;
    if (!device) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    if (address.length == 0) {
        return;
    }

    (void)[self sessionForDevice:device createIfNeeded:YES];
    [self registerDisconnectNotification:device];
    macos_bt_on_device_event([address UTF8String], 1);
}

- (void)deviceDisconnected:(IOBluetoothUserNotification *)note device:(IOBluetoothDevice *)device {
    (void)note;
    if (!device) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    NSString *addressKey = normalizedAddress(address);
    if (addressKey.length == 0) {
        return;
    }

    if ([device isConnected]) {
        BTLOG(@"Ignore stale disconnect callback (still connected): %@", address);
        return;
    }

    [self unregisterDisconnectNotificationForAddress:address];

    StoneDeviceSession *session = [self sessionForAddressKey:addressKey createIfNeeded:NO];
    if (session) {
        if (session.channel) {
            BTLOG(@"RFCOMM closed by disconnect callback (%@)", address);
            session.channel = nil;
        }
        session.device = nil;
        [self removeSessionIfInactive:addressKey];
    }

    macos_bt_on_device_event([address UTF8String], 0);
}

- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    NSString *address = device.addressString ?: @"";
    NSString *key = normalizedAddress(address);

    StoneDeviceSession *session = [self sessionForAddressKey:key createIfNeeded:NO];
    if (session) {
        @synchronized(session) {
            session.pendingSDPDone = YES;
            session.pendingSDPStatus = status;
        }
    }

    BTLOG(@"SDP query complete: status=%d (%@)", (int)status, address);
}

- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)rfcommChannel
                     data:(void *)dataPointer
                   length:(size_t)dataLength {
    if (!rfcommChannel || !dataPointer || dataLength == 0) {
        return;
    }

    IOBluetoothDevice *device = [rfcommChannel getDevice];
    NSString *address = device.addressString ?: @"";
    NSString *addressKey = normalizedAddress(address);
    if (addressKey.length > 0) {
        StoneDeviceSession *session = [self sessionForAddressKey:addressKey createIfNeeded:YES];
        session.device = device;
        session.channel = rfcommChannel;
    }
    if (address.length > 0) {
        macos_bt_on_data([address UTF8String], (const uint8_t *)dataPointer, dataLength);
    }
}

- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)rfcommChannel {
    if (!rfcommChannel) {
        return;
    }

    IOBluetoothDevice *device = [rfcommChannel getDevice];
    NSString *address = device.addressString ?: @"";
    NSString *addressKey = normalizedAddress(address);
    StoneDeviceSession *session = [self sessionForAddressKey:addressKey createIfNeeded:NO];
    if (session && session.channel == rfcommChannel) {
        session.channel = nil;
        if (!device || ![device isConnected]) {
            session.device = nil;
        }
        [self removeSessionIfInactive:addressKey];
    }
}

@end

static IOBluetoothDevice *findDeviceForAddress(NSString *address) {
    if (!address || address.length == 0) {
        return nil;
    }

    IOBluetoothDevice *device = [IOBluetoothDevice deviceWithAddressString:address];
    if (device) {
        return device;
    }

    NSString *target = normalizedAddress(address);
    NSArray *paired = [IOBluetoothDevice pairedDevices] ?: @[];
    for (IOBluetoothDevice *candidate in paired) {
        NSString *candidateAddress = normalizedAddress(candidate.addressString ?: @"");
        if (candidateAddress.length > 0 && [candidateAddress isEqualToString:target]) {
            return candidate;
        }
    }

    return nil;
}

char *macos_bt_list_paired_devices(void) {
    __block char *result = NULL;

    runOnMainSync(^{
        StoneBluetoothManager *manager = [StoneBluetoothManager shared];
        [manager ensureConnectionNotifications];

        NSMutableArray *entries = [NSMutableArray array];
        NSArray *paired = [IOBluetoothDevice pairedDevices] ?: @[];
        IOBluetoothSDPUUID *gaiaUUID = stoneGaiaSDPUUID();

        for (IOBluetoothDevice *device in paired) {
            NSString *address = device.addressString ?: @"";
            if (address.length == 0) {
                continue;
            }

            NSString *name = device.name ?: @"(unknown)";
            IOBluetoothSDPServiceRecord *gaiaRecord = [device getServiceRecordForUUID:gaiaUUID];

            [entries addObject:@{
                @"name" : name,
                @"address" : address,
                @"connected" : jsonBool([device isConnected]),
                @"has_gaia" : jsonBool(gaiaRecord != nil),
                @"paired" : jsonBool(YES)
            }];
        }

        result = jsonCStringFromObject(entries, "[]");
    });

    if (!result) {
        return strdup("[]");
    }
    return result;
}

char *macos_bt_scan_unpaired_stone_devices(void) {
    __block StoneDeviceInquiryCollector *collector = nil;
    dispatch_semaphore_t started = dispatch_semaphore_create(0);
    dispatch_semaphore_t done = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        StoneBluetoothManager *manager = [StoneBluetoothManager shared];

        if (manager.scanInquiry) {
            (void)[manager.scanInquiry stop];
            manager.scanInquiry = nil;
            manager.scanCollector = nil;
        }

        collector = [[StoneDeviceInquiryCollector alloc] init];
        collector.doneSemaphore = done;

        IOBluetoothDeviceInquiry *inquiry = [IOBluetoothDeviceInquiry inquiryWithDelegate:collector];
        if (!inquiry) {
            dispatch_semaphore_signal(started);
            dispatch_semaphore_signal(done);
            return;
        }

        inquiry.updateNewDeviceNames = YES;
        inquiry.inquiryLength = 4;

        manager.scanCollector = collector;
        manager.scanInquiry = inquiry;

        IOReturn startStatus = [inquiry start];
        dispatch_semaphore_signal(started);

        if (startStatus != kIOReturnSuccess) {
            BTLOG(@"Inquiry start failed: status=%d", (int)startStatus);
            manager.scanInquiry = nil;
            manager.scanCollector = nil;
            dispatch_semaphore_signal(done);
            return;
        }

        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(),
                       ^{
                           StoneBluetoothManager *current = [StoneBluetoothManager shared];
                           if (current.scanCollector == collector && !collector.completed) {
                               (void)[current.scanInquiry stop];
                           }
                       });
    });

    dispatch_time_t startedWait = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(started, startedWait) != 0) {
        return strdup("[]");
    }

    dispatch_time_t doneWait = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(6 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(done, doneWait) != 0) {
        dispatch_async(dispatch_get_main_queue(), ^{
            StoneBluetoothManager *manager = [StoneBluetoothManager shared];
            if (manager.scanCollector == collector) {
                (void)[manager.scanInquiry stop];
                manager.scanInquiry = nil;
                manager.scanCollector = nil;
            }
        });
        return strdup("[]");
    }

    __block NSArray *entries = @[];
    runOnMainSync(^{
        StoneBluetoothManager *manager = [StoneBluetoothManager shared];
        if (manager.scanCollector == collector) {
            entries = [collector.entriesByAddress allValues] ?: @[];
            manager.scanInquiry = nil;
            manager.scanCollector = nil;
        }
    });

    BTLOG(@"Inquiry result: %lu unpaired STONE", (unsigned long)entries.count);
    return jsonCStringFromObject(entries, "[]");
}

int macos_bt_sdp_query(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }

    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    @try {
        IOBluetoothDevice *device = findDeviceForAddress(addr);
        if (!device) {
            [StoneBluetoothManager shared].lastErrorContext = @"device_not_found";
            return (int)kIOReturnNotFound;
        }

        StoneBluetoothManager *manager = [StoneBluetoothManager shared];
        StoneDeviceSession *session =
            [manager sessionForAddress:addr createIfNeeded:YES];
        if (!session) {
            manager.lastErrorContext = @"invalid_address";
            return (int)kIOReturnBadArgument;
        }
        session.device = device;
        [manager registerDisconnectNotification:device];
        return (int)[manager performSDPQueryAndWaitForSession:session timeout:kStoneOpTimeout];
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext =
            [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
}

char *macos_bt_get_connection_infos(void) {
    __block NSArray<NSDictionary *> *infos = nil;

    runOnMainSync(^{
        infos = [[StoneBluetoothManager shared] currentConnectionInfos];
    });

    if (!infos) {
        return strdup("[]");
    }

    return jsonCStringFromObject(infos, "[]");
}

int macos_bt_connect(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }

    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    @try {
        IOReturn status = [[StoneBluetoothManager shared] connectToAddress:addr];
        return (int)status;
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext =
            [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
}

int macos_bt_disconnect(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }

    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    @try {
        IOReturn status = [[StoneBluetoothManager shared] disconnectAddress:addr];
        return (int)status;
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext =
            [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
}

int macos_bt_write(const char *address, const uint8_t *data, size_t len) {
    if (!address || !data || len == 0) {
        return (int)kIOReturnBadArgument;
    }

    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    NSData *payload = [NSData dataWithBytes:data length:len];
    __block IOReturn status = kIOReturnError;

    runOnMainSync(^{
        @try {
            status = [[StoneBluetoothManager shared] sendDataToAddress:addr data:payload];
        } @catch (NSException *exception) {
            [StoneBluetoothManager shared].lastErrorContext =
                [NSString stringWithFormat:@"exception:%@", exception.name];
            status = kIOReturnError;
        }
    });

    return (int)status;
}

char *macos_bt_last_error_context(void) {
    NSString *context = [StoneBluetoothManager shared].lastErrorContext;
    if (!context || context.length == 0) {
        return strdup("");
    }
    return strdup([context UTF8String]);
}
