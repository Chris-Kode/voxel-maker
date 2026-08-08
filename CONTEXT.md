# Voxel Asset Editing

This context defines the shared language for a generic voxel asset whose manual and AI-assisted changes remain deterministic, reviewable, and recoverable.

## Language

**Document**:
The authoritative semantic representation of one voxel asset.
_Avoid_: Project, scene, model

**Node**:
An ordered hierarchy element that locates and organizes asset content.
_Avoid_: Object, bone, part

**Voxel Volume**:
A three-dimensional collection of material-valued voxels.
_Avoid_: Mesh, grid

**Chunk**:
A bounded cubic subdivision of a Voxel Volume.
_Avoid_: Block, tile

**Command**:
A complete statement of intent for one persistent edit.
_Avoid_: Action, operation, mutation

**Transaction**:
An ordered group of Commands accepted or rejected as one change.
_Avoid_: Batch, command group

**Revision**:
The identity of one committed Document state.
_Avoid_: Version, save

**Lifecycle**:
A transition that replaces the authoritative Document as a whole when creating, opening, recovering, or closing an asset.
_Avoid_: Edit, reload

**Preview Session**:
An isolated prospective Document state in which proposed changes can be inspected without affecting the live Document.
_Avoid_: Draft document, temporary project

**Joint**:
A generic articulation point associated with a Node in the asset hierarchy.
_Avoid_: Bone

**Constraint**:
A deterministic rule that bounds an articulated pose.
_Avoid_: Limiter, controller

**Clip**:
A bounded, named collection of property Tracks evaluated over a duration.
_Avoid_: Animation

**Track**:
An ordered set of typed keyframes targeting one property of an identified asset element.
_Avoid_: Channel, curve

**Skill**:
Removable domain knowledge that guides asset changes without becoming part of the Document.
_Avoid_: Plugin, document type
