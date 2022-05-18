pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

template CheckRoot(n) { // compute the root of a MerkleTree of n Levels 
    signal input leaves[2**n];
    signal output root;

    //[assignment] insert your code here to calculate the Merkle root from 2^n leaves
    // number of leaves in the tree
    var leafCount = 2**n;

    // max number of nodes for  n level tree
    var nodeLimit = 2**(n+1) - 1;

    // store the hases
    component hashes[leafCount - 1];
    // tree with hases of nodes
    var tree[nodeLimit];

    // storing the leaves hashes in the tree
    for (var i = 0; i < leafCount; i++) {
        tree[i] = leaves[i];
    }

    // hashes of nodes
    for (var i = 0; i < leafCount - 1; i++) {
        // poseidon circuit with 2 inputs 
        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== tree[2 * i];
        hashes[i].inputs[1] <== tree[2 * i + 1];
        // output poseidon hash 
        tree[leafCount + 1] = hashes[i].out;
    }

    // root
    root <== hashes[leafCount - 2].out;
}

template MerkleTreeInclusionProof(n) {
    signal input leaf;
    signal input path_elements[n];
    signal input path_index[n]; // path index are 0's and 1's indicating whether the current element is on the left or right
    signal output root; // note that this is an OUTPUT signal

    //[assignment] insert your code here to compute the root from a leaf and elements along the path
    component poseidon[n];
    signal objs[n+1];

    objs[0] <== leaf;

    for (var i = 0; i < n; i++) {
        // Poseidon with 2 inputs
        poseidon[i] = Poseidon(2);

        assert(path_index[i] == 0 || path_index[i] == 1);


        poseidon[i].inputs[0] <== (path_elements[i] - objs[i]) * path_index[i] + objs[i];
        poseidon[i].inputs[1] <== (objs[i] - path_elements[i]) * path_index[i] + path_elements[i];
        
        objs[i+1] <== poseidon[i].out;
    }
    // returning the root 
    root <== objs[n];
}