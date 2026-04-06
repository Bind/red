/// libgitty - Pure Zig git implementation for bottega.
/// No external dependencies. Feature-complete for git smart HTTP protocol.
pub const sha1 = @import("sha1.zig");
pub const deflate = @import("deflate.zig");
pub const object = @import("object.zig");
pub const delta = @import("delta.zig");
pub const pack = @import("pack.zig");
pub const packindex = @import("packindex.zig");
pub const packreader = @import("packreader.zig");
pub const protocol = @import("protocol.zig");
pub const diff = @import("diff.zig");
pub const diffLines = diff.diffLines;
pub const unifiedDiff = diff.unifiedDiff;
pub const diffTrees = diff.diffTrees;
pub const TreeChange = diff.TreeChange;
pub const TreeChangeKind = diff.TreeChangeKind;
pub const diffTreesRecursive = diff.diffTreesRecursive;
pub const TreeLoader = diff.TreeLoader;
pub const walk = @import("walk.zig");
pub const storage = @import("storage.zig");

// Re-export key types
pub const ObjectType = object.ObjectType;
pub const PackEntry = pack.PackEntry;
pub const StorageAdapter = protocol.StorageAdapter;
pub const Ref = protocol.Ref;
pub const RefCommand = protocol.RefCommand;

// Re-export key functions
pub const hashObject = object.hashObject;
pub const hashObjectDigest = object.hashObjectDigest;
pub const encodeObject = object.encodeObject;
pub const decodeObject = object.decodeObject;
pub const parseTree = object.parseTree;
pub const buildTree = object.buildTree;
pub const parseCommit = object.parseCommit;
pub const buildCommit = object.buildCommit;
pub const parseTag = object.parseTag;
pub const buildTag = object.buildTag;
pub const TreeEntry = object.TreeEntry;
pub const CommitInfo = object.CommitInfo;
pub const TagInfo = object.TagInfo;

pub const parsePack = pack.parsePack;
pub const buildPack = pack.buildPack;
pub const buildPackDelta = pack.buildPackDelta;
pub const indexPack = pack.indexPack;
pub const PackEntryMeta = pack.PackEntryMeta;
pub const PackIndex = packindex.PackIndex;
pub const IndexEntry = packindex.IndexEntry;
pub const buildIndex = packindex.buildIndex;
pub const PackReader = packreader.PackReader;
pub const ResolvedObject = packreader.ResolvedObject;

pub const handleReceivePack = protocol.handleReceivePack;
pub const handleUploadPack = protocol.handleUploadPack;
pub const advertiseRefs = protocol.advertiseRefs;
pub const advertiseRefsWithOptions = protocol.advertiseRefsWithOptions;
pub const AdvertiseOptions = protocol.AdvertiseOptions;
pub const pktLine = protocol.pktLine;
pub const pktLineAppend = protocol.pktLineAppend;
pub const SideBand = protocol.SideBand;
pub const Capabilities = protocol.Capabilities;
pub const parseCapabilities = protocol.parseCapabilities;
pub const resolveRef = protocol.resolveRef;
pub const parseSymbolicRef = protocol.parseSymbolicRef;

// Walk / graph
pub const ObjectLoader = walk.ObjectLoader;
pub const revList = walk.revList;
pub const isAncestor = walk.isAncestor;
pub const collectReachableObjects = walk.collectReachableObjects;
pub const mergeBase = walk.mergeBase;

// Storage
pub const DiskStorage = storage.DiskStorage;

pub const tests = @import("tests.zig");

test {
    @import("std").testing.refAllDecls(@This());
}
