// sim-hid: a long-lived touch injector for one booted iOS Simulator.
//
// The simulator panel starts one of these per device and writes one JSON object per line on stdin:
//   {"id":1,"t":"down","x":0.5,"y":0.5}    x and y are 0-1 fractions from the top left
//   {"id":2,"t":"move","x":0.5,"y":0.4}
//   {"id":3,"t":"up","x":0.5,"y":0.4}
// and reads one line per event on stdout, {"id":1,"ok":true} or {"id":1,"ok":false,"error":"..."},
// written once the simulator has taken the event. The first line is {"ready":true} or {"error":"..."}.
//
// It talks to the simulator the way Simulator.app does: Xcode's SimulatorKit builds the Indigo HID
// message and its SimDeviceLegacyHIDClient delivers it over the device's HID port. Both frameworks
// are Apple's own, loaded at run time from the installed Xcode, so nothing here links against them
// and a Developer ID build with library validation loads them as it would any system library.
// The message layout follows facebook/idb (MIT), FBSimulatorControl/HID/SimulatorIndigoHID.swift.
//
// Build: clang -fobjc-arc -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -framework Foundation -framework CoreGraphics sim-hid.m -o sim-hid

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach_time.h>

@protocol SimHIDPrivate
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSDictionary *)devicesByUDID;
- (id)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)free completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
@end

// IndigoHIDMessageForMouseNSEvent(point, secondPoint, target, NSEventType, size, edge): returns a malloc'd message.
typedef void *(*MouseMessageFn)(CGPoint *, CGPoint *, uint32_t, NSUInteger, CGSize, uint32_t);

// Offsets inside an Indigo message (idb's Indigo.h, 4-byte packed).
enum {
  kInnerSizeOffset = 0x18, kEventTypeOffset = 0x1c, kPayloadOffset = 0x20, kTimestampOffset = 0x24,
  kTouchOffset = 0x30, kXRatioOffset = 0x3c, kYRatioOffset = 0x44,
  kPayloadSize = 0x90, kTouchSize = 0x70, kMessageSize = 0x20 + 0x90 + 0x90,
};

static MouseMessageFn mouseMessage;
static id client;
static dispatch_queue_t outQueue;

static void emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  dispatch_async(outQueue, ^{
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  });
}

static void fail(NSString *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"error": message} options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  exit(1);
}

// A single-finger contact at a 0-1 screen fraction: SimulatorKit builds the digitizer payload, which
// is then wrapped as a single-touch message (two payloads, the second a marked copy of the first).
static void *touchMessage(double x, double y, BOOL down) {
  CGPoint point = CGPointMake(x, y);
  uint8_t *source = mouseMessage(&point, NULL, 0x32, down ? 1 : 2, CGSizeMake(1, 1), 0);
  if (!source) return NULL;
  memcpy(source + kXRatioOffset, &point.x, sizeof(double));
  memcpy(source + kYRatioOffset, &point.y, sizeof(double));
  uint8_t *message = calloc(1, kMessageSize);
  uint32_t innerSize = kPayloadSize, kind = 0x0b, one = 1, two = 2;
  uint64_t now = mach_absolute_time();
  memcpy(message + kInnerSizeOffset, &innerSize, 4);
  message[kEventTypeOffset] = 2;
  memcpy(message + kPayloadOffset, &kind, 4);
  memcpy(message + kTimestampOffset, &now, 8);
  memcpy(message + kTouchOffset, source + kTouchOffset, kTouchSize);
  free(source);
  uint8_t *second = message + kPayloadOffset + kPayloadSize;
  memcpy(second, message + kPayloadOffset, kPayloadSize);
  memcpy(second + 0x10, &one, 4);
  memcpy(second + 0x14, &two, 4);
  return message;
}

static void *load(NSString *path) { return dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_GLOBAL); }

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    outQueue = dispatch_queue_create("sim-hid.out", DISPATCH_QUEUE_SERIAL);
    if (argc < 3) fail(@"usage: sim-hid <udid> <developer-dir>");
    NSUUID *udid = [[NSUUID alloc] initWithUUIDString:@(argv[1])];
    NSString *developerDir = @(argv[2]);
    if (!udid) fail(@"bad udid");

    if (!load(@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator")) fail(@"CoreSimulator not found");
    void *kit = NULL;
    // Xcode 15 and later keep SimulatorKit in SharedFrameworks; older ones under the developer dir.
    for (NSString *relative in @[@"../SharedFrameworks/SimulatorKit.framework/SimulatorKit", @"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"]) {
      if ((kit = load([developerDir stringByAppendingPathComponent:relative]))) break;
    }
    if (!kit) fail(@"SimulatorKit not found");
    mouseMessage = (MouseMessageFn)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
    Class contextClass = NSClassFromString(@"SimServiceContext");
    Class clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
    if (!mouseMessage || !contextClass || !clientClass) fail(@"this Xcode has no simulator HID client");

    @try {
      NSError *error = nil;
      id context = [contextClass sharedServiceContextForDeveloperDir:developerDir error:&error];
      id set = [context defaultDeviceSetWithError:&error];
      id device = [set devicesByUDID][udid];
      if (!device) fail(error.localizedDescription ?: @"device not found");
      client = [[clientClass alloc] initWithDevice:device error:&error];
      if (!client) fail(error.localizedDescription ?: @"HID client failed");
    } @catch (NSException *exception) {
      fail(exception.reason ?: @"HID client failed");
    }
    emit(@{@"ready": @YES});

    dispatch_queue_t ackQueue = dispatch_queue_create("sim-hid.ack", DISPATCH_QUEUE_SERIAL);
    BOOL isDown = NO;
    double lastX = 0, lastY = 0;
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) > 0) {
      @autoreleasepool {
        NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytesNoCopy:line length:(NSUInteger)length freeWhenDone:NO] options:0 error:nil];
        if (![event isKindOfClass:NSDictionary.class]) continue;
        id eventId = event[@"id"] ?: @0;
        NSString *type = event[@"t"];
        NSNumber *x = event[@"x"], *y = event[@"y"];
        BOOL down = [type isEqual:@"down"] || [type isEqual:@"move"];
        if ((!down && ![type isEqual:@"up"]) || ![x isKindOfClass:NSNumber.class] || ![y isKindOfClass:NSNumber.class]) {
          emit(@{@"id": eventId, @"ok": @NO, @"error": @"bad event"});
          continue;
        }
        lastX = fmin(1, fmax(0, x.doubleValue));
        lastY = fmin(1, fmax(0, y.doubleValue));
        isDown = down;
        void *message = touchMessage(lastX, lastY, down);
        if (!message) {
          emit(@{@"id": eventId, @"ok": @NO, @"error": @"SimulatorKit built no touch message"});
          continue;
        }
        @try {
          [client sendWithMessage:message freeWhenDone:YES completionQueue:ackQueue completion:^(NSError *error) {
            emit(error ? @{@"id": eventId, @"ok": @NO, @"error": error.localizedDescription ?: @"send failed"} : @{@"id": eventId, @"ok": @YES});
          }];
        } @catch (NSException *exception) {
          emit(@{@"id": eventId, @"ok": @NO, @"error": exception.reason ?: @"send failed"});
        }
      }
    }
    // Never leave a finger on the glass when the app goes away mid-drag.
    void *lift = isDown ? touchMessage(lastX, lastY, NO) : NULL;
    if (lift) {
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      @try {
        [client sendWithMessage:lift freeWhenDone:YES completionQueue:ackQueue completion:^(NSError *error) { dispatch_semaphore_signal(done); }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
      } @catch (NSException *exception) { }
    }
    dispatch_sync(outQueue, ^{});
  }
  return 0;
}
